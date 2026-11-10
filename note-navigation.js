/**
 * Tracks navigation intent separately from the editor session currently displayed.
 * Operation callbacks use the session token; navigation replies use their ticket.
 */
export class NoteNavigation {
  #counter = 0;
  #current = null;
  #makeToken;

  constructor(makeToken = () => globalThis.crypto.randomUUID()) {
    this.#makeToken = makeToken;
  }

  get intent() {
    return this.#counter;
  }

  get current() {
    return this.#current === null ? null : { ...this.#current };
  }

  begin() {
    return ++this.#counter;
  }

  accepts(ticket) {
    return ticket === this.#counter;
  }

  open(ticket, entry) {
    if (!this.accepts(ticket)) return null;
    this.#current = { ...entry, token: this.#makeToken(), intent: ticket };
    return this.current;
  }

  replace(token, entry) {
    if (this.#current === null || this.#current.token !== token) return null;
    // Replacing the displayed session must leave a pending navigation valid.
    this.#current = { ...entry, token: this.#makeToken(), intent: this.#counter };
    return this.current;
  }

  closeFrom(token) {
    if (this.#current === null || this.#current.token !== token) return false;
    this.#current = null;
    return true;
  }

  back() {
    ++this.#counter;
    this.#current = null;
    return null;
  }

  cancelPending() {
    ++this.#counter;
  }

  keepCurrent(noteId) {
    if (!this.#current?.note || this.#current.note.id !== noteId) return null;
    this.#current = { ...this.#current, intent: ++this.#counter };
    return this.current;
  }
}
