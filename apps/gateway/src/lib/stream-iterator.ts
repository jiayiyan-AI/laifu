import Resolveable from './resolveable-promise.js';

class Stream<T = any> implements AsyncIterator<T>, AsyncIterable<T> {
  private closed = false;
  private task?: Resolveable<IteratorResult<T>>;
  private buffer: T[] = [];

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.buffer.length) {
      return { done: false, value: this.buffer.shift()! };
    }

    if (this.closed) {
      return { done: true, value: undefined };
    }

    if (!this.task) {
      this.task = new Resolveable<IteratorResult<T>>();
    }

    return this.task;
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { done: true, value: undefined };
  }

  private resolve(done: boolean, value: T | undefined) {
    if (this.task) {
      this.task.resolve({ done, value } as IteratorResult<T>);
      this.task = undefined;
      return true;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.resolve(true, undefined);
  }

  send(value: T) {
    if (this.closed) {
      throw new Error('Channel is closed');
    }
    if (this.resolve(false, value)) return;
    else this.buffer.push(value);
  }
}

export default Stream;
