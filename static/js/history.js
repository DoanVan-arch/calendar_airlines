/* history.js – Undo / Redo manager */
class HistoryManager {
  constructor(maxSize = 50) {
    this._stack = [];
    this._idx = -1;
    this._maxSize = maxSize;
    this.onchange = null; // callback to update UI buttons
  }

  /**
   * Push an action. action = { label, undo: async fn, redo: async fn }
   * Call this AFTER the initial "do" has already been performed.
   */
  push(action) {
    // Drop any redo history beyond current index
    this._stack.splice(this._idx + 1);
    this._stack.push(action);
    if (this._stack.length > this._maxSize) this._stack.shift();
    else this._idx++;
    this._notify();
  }

  async undo() {
    if (!this.canUndo()) return;
    await this._stack[this._idx].undo();
    this._idx--;
    this._notify();
  }

  async redo() {
    if (!this.canRedo()) return;
    this._idx++;
    await this._stack[this._idx].redo();
    this._notify();
  }

  canUndo() { return this._idx >= 0; }
  canRedo() { return this._idx < this._stack.length - 1; }
  clear()   { this._stack = []; this._idx = -1; this._notify(); }

  _notify() {
    if (typeof this.onchange === "function") this.onchange(this.canUndo(), this.canRedo());
  }
}
