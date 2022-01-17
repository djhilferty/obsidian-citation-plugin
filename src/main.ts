import {
  FileSystemAdapter,
  MarkdownSourceView,
  MarkdownView,
  normalizePath,
  Plugin,
  TFile,
} from 'obsidian';
import * as path from 'path';
import * as chokidar from 'chokidar';
import * as CodeMirror from 'codemirror';
import {
  compile as compileTemplate,
  Exception,
  TemplateDelegate as Template,
} from 'handlebars';
import {
  InsertCitationModal,
  InsertNoteLinkModal,
  InsertNoteContentModal,
  OpenNoteModal,
} from './modals';
import { VaultExt } from './obsidian-extensions.d';
import {
  CitationSettingTab,
  CitationsPluginSettings,
  DEFAULT_SETTINGS,
} from './settings';
import {
  Entry,
  EntryData,
  EntryBibLaTeXAdapter,
  EntryCSLAdapter,
  IIndexable,
  Library,
  loadEntries,
} from './types';
import { DISALLOWED_FILENAME_CHARACTERS_RE, Notifier } from './util';

export default class CitationPlugin extends Plugin {
  settings: CitationsPluginSettings;
  library: Library;

  // Template compilation options
  private templateSettings = {
    noEscape: true,
  };

  loadErrorNotifier = new Notifier(
    'Unable to load citations. Please update Citations plugin settings.',
  );
  literatureNoteErrorNotifier = new Notifier(
    'Unable to access literature note. Please check that the literature note folder exists, or update the Citations plugin settings.',
  );

  get editor(): CodeMirror.Editor {
    const view = this.app.workspace.activeLeaf.view;
    if (!(view instanceof MarkdownView)) return null;

    const sourceView = view.sourceMode;
    return (sourceView as MarkdownSourceView).cmEditor;
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async onload() {
    console.log('CitationPlugin.onload()');
    await this.loadSettings();
    this.init();
    this.addSettingTab(new CitationSettingTab(this.app, this));
  }

  async init() {
    console.log('CitationPlugin.init()');
    this.library = await this.loadLibrary();

    // Set up a watcher to refresh whenever the export is updated
    try {
      // Wait until files are finished being written before going ahead with
      // the refresh -- here, we request that `change` events be accumulated
      // until nothing shows up for 500 ms
      // TODO magic number
      const watchOptions = {
        awaitWriteFinish: {
          stabilityThreshold: 500,
        },
      };

      chokidar
        .watch(
          this.resolveLibraryPath(this.settings.citationExportPath),
          watchOptions,
        )
        .on('change', async () => {
          this.library = await this.loadLibrary();
        });
    } catch {
      this.loadErrorNotifier.show();
    }

    this.addCommand({
      id: 'open-literature-note',
      name: 'Open literature note',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'o' }],
      callback: () => {
        const modal = new OpenNoteModal(
          this.app,
          this,
          this.editor.getSelection(),
        );
        modal.open();
      },
    });

    this.addCommand({
      id: 'update-bib-data',
      name: 'Refresh citation database',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'r' }],
      callback: async () => {
        this.library = await this.loadLibrary();
      },
    });

    this.addCommand({
      id: 'insert-citation',
      name: 'Insert literature note link',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'e' }],
      callback: () => {
        const modal = new InsertNoteLinkModal(
          this.app,
          this,
          this.editor.getSelection(),
        );
        modal.open();
      },
    });

    this.addCommand({
      id: 'insert-literature-note-content',
      name: 'Insert literature note content in the current pane',
      callback: () => {
        const modal = new InsertNoteContentModal(
          this.app,
          this,
          this.editor.getSelection(),
        );
        modal.open();
      },
    });

    this.addCommand({
      id: 'insert-markdown-citation',
      name: 'Insert Markdown citation',
      callback: () => {
        const modal = new InsertCitationModal(
          this.app,
          this,
          this.editor.getSelection(),
        );
        modal.open();
      },
    });
  }

  /**
   * Resolve a provided library path, allowing for relative paths rooted at
   * the vault directory.
   */
  resolveLibraryPath(rawPath: string): string {
    const vaultRoot =
      this.app.vault.adapter instanceof FileSystemAdapter
        ? this.app.vault.adapter.getBasePath()
        : '/';
    return path.resolve(vaultRoot, rawPath);
  }

  async loadLibrary(): Promise<Library> {
    console.debug('Citation plugin: Reloading library');
    if (this.settings.citationExportPath) {
      const filePath = this.resolveLibraryPath(
        this.settings.citationExportPath,
      );

      try {
        let buffer = await FileSystemAdapter.readLocalFile(filePath);
        const dataView = new DataView(buffer);
        const decoder = new TextDecoder('utf8');
        const value = decoder.decode(dataView);

        let entries = loadEntries(value, this.settings.citationExportFormat);
        let adapter: new (data: EntryData) => Entry;
        let idKey: string;

        switch (this.settings.citationExportFormat) {
          case 'biblatex':
            adapter = EntryBibLaTeXAdapter;
            idKey = 'key';
            break;
          case 'csl-json':
            adapter = EntryCSLAdapter;
            idKey = 'id';
            break;
        }

        const newLibrary = new Library(
          Object.fromEntries(
            entries.map((e) => [(e as IIndexable)[idKey], new adapter(e)]),
          ),
        );
        console.debug(
          `Citation plugin: successfully loaded library with ${this.library.size} entries.`,
        );

        return newLibrary;
      } catch (e) {
        console.error(e);
        this.loadErrorNotifier.show();

        return null;
      }
    } else {
      console.warn(
        'Citations plugin: citation export path is not set. Please update plugin settings.',
      );
    }
    return null;
  }

  /**
   * Returns true iff the library is currently being loaded on the worker thread.
   */
  get isLibraryLoading(): boolean {
    return this.loadWorker.blocked;
  }

  getTitleForCitekey(citekey: string): string {
    const unsafeTitle = compileTemplate(
      this.settings.literatureNoteTitleTemplate,
      this.templateSettings,
    )(this.library.getTemplateVariablesForCitekey(citekey));
    return unsafeTitle.replace(DISALLOWED_FILENAME_CHARACTERS_RE, '_');
  }

  getPathForCitekey(citekey: string): string {
    const title = this.getTitleForCitekey(citekey);
    // TODO escape note title
    return path.join(this.settings.literatureNoteFolder, `${title}.md`);
  }

  getInitialContentForCitekey(citekey: string): string {
    return compileTemplate(
      this.settings.literatureNoteContentTemplate,
      this.templateSettings,
    )({
      selectedText: this.editor.getSelection(),
      ...this.library.getTemplateVariablesForCitekey(citekey),
    });
  }

  getMarkdownCitationForCitekey(citekey: string): string {
    return compileTemplate(
      this.settings.markdownCitationTemplate,
      this.templateSettings,
    )({
      selectedText: this.editor.getSelection(),
      ...this.library.getTemplateVariablesForCitekey(citekey),
    });
  }

  getAlternativeMarkdownCitationForCitekey(citekey: string): string {
    return compileTemplate(
      this.settings.alternativeMarkdownCitationTemplate,
      this.templateSettings,
    )({
      selectedText: this.editor.getSelection(),
      ...this.library.getTemplateVariablesForCitekey(citekey),
    });
  }

  /**
   * Run a case-insensitive search for the literature note file corresponding to
   * the given citekey. If no corresponding file is found, create one.
   */
  async getOrCreateLiteratureNoteFile(citekey: string): Promise<TFile> {
    const path = this.getPathForCitekey(citekey);
    const normalizedPath = normalizePath(path);

    let file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (file == null) {
      // First try a case-insensitive lookup.
      const matches = this.app.vault
        .getMarkdownFiles()
        .filter((f) => f.path.toLowerCase() == normalizedPath.toLowerCase());
      if (matches.length > 0) {
        file = matches[0];
      } else {
        try {
          file = await this.app.vault.create(
            path,
            this.getInitialContentForCitekey(citekey),
          );
        } catch (exc) {
          this.literatureNoteErrorNotifier.show();
          throw exc;
        }
      }
    }

    return file as TFile;
  }

  async openLiteratureNote(citekey: string, newPane: boolean) {
    this.getOrCreateLiteratureNoteFile(citekey)
      .then((file: TFile) => {
        this.app.workspace.getLeaf(newPane).openFile(file);
      })
      .catch(console.error);
  }

  async insertLiteratureNoteLink(citekey: string) {
    this.getOrCreateLiteratureNoteFile(citekey)
      .then((file: TFile) => {
        const useMarkdown: boolean = (<VaultExt>this.app.vault).getConfig(
          'useMarkdownLinks',
        );
        const title = this.getTitleForCitekey(citekey);

        let linkText: string;
        if (useMarkdown) {
          const uri = encodeURI(
            this.app.metadataCache.fileToLinktext(file, '', false),
          );
          linkText = `[${title}](${uri})`;
        } else {
          linkText = `[[${title}]]`;
        }

        this.editor.replaceSelection(linkText, this.editor.getSelection());
      })
      .catch(console.error);
  }

  /**
   * Format literature note content for a given reference and insert in the
   * currently active pane.
   */
  async insertLiteratureNoteContent(citekey: string) {
    const content = this.getInitialContentForCitekey(citekey);
    this.editor.getSelection();
    this.editor.replaceSelection(content, this.editor.getSelection());
  }

  async insertMarkdownCitation(citekey: string, alternative = false) {
    const func = alternative
      ? this.getAlternativeMarkdownCitationForCitekey
      : this.getMarkdownCitationForCitekey;
    const citation = func.bind(this)(citekey);

    this.editor.replaceSelection(citation, this.editor.getSelection());
  }
}
