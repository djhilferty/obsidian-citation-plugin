import { Notice } from 'obsidian';

import PromiseWorker from 'promise-worker';

import { NoticeExt } from './obsidian-extensions';

export const DISALLOWED_FILENAME_CHARACTERS_RE = /[*"\\/<>:|?]/g;

/**
 * Manages a category of notices to be displayed in the UI. Prevents multiple
 * notices being shown at the same time.
 */
export class Notifier {
  static DISAPPEARING_CLASS = 'mod-disappearing';
  currentNotice?: NoticeExt;
  mutationObserver?: MutationObserver;

  constructor(public defaultMessage: string) {}

  unload(): void {
    this.hide();
  }

  /**
   * @returns true if the notice was shown, and false otherwise
   */
  show(message?: string): boolean {
    message = message || this.defaultMessage;
    if (this.currentNotice) return false;

    this.currentNotice = new Notice(message) as NoticeExt;

    // Set up mutation observer to watch for when the notice disappears.
    this.mutationObserver?.disconnect();
    this.mutationObserver = new MutationObserver((changes, observer) => {
      const isDisappearing = changes.some((change) => {
        const el = change.target as HTMLElement;
        return (
          change.type == 'attributes' &&
          el.hasClass(NoticeExt.DISAPPEARING_CLASS)
        );
      });
      if (isDisappearing) {
        this.currentNotice = null;
        observer.disconnect();
        this.mutationObserver = null;
      }
    });
    this.mutationObserver.observe(this.currentNotice.noticeEl, {
      attributeFilter: ['class'],
    });
  }

  hide(): void {
    this.currentNotice?.hide();
    this.mutationObserver?.disconnect();

    this.currentNotice = null;
    this.mutationObserver = null;
  }
}
