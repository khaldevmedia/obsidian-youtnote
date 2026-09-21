export class KeyedSerialQueue<TKey extends object> {
    private tails = new Map<TKey, Promise<void>>();

    async run<TResult>(key: TKey, task: () => Promise<TResult>): Promise<TResult> {
        const previous = this.tails.get(key) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(task);
        const tail = result.then(() => undefined, () => undefined);
        this.tails.set(key, tail);
        try {
            return await result;
        } finally {
            if (this.tails.get(key) === tail) {
                this.tails.delete(key);
            }
        }
    }
}
