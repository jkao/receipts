export class KeyedSerialQueue<Key> {
  private readonly tails = new Map<Key, Promise<void>>();

  run<Result>(key: Key, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);

    return result.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
  }
}
