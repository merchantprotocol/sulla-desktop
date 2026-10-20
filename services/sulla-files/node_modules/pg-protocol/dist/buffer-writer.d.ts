export declare class Writer {
    private size;
    buffer: Buffer;
    private offset;
    private headerPosition;
    constructor(size?: number);
    private ensure;
    addInt32(num: number): Writer;
    addInt16(num: number): Writer;
    addCString(string: string): Writer;
    addString(string?: string): Writer;
    addInt32PrefixedString(string: string): Writer;
    add(otherBuffer: Buffer): Writer;
    /**
     * Appends an uninitialized block of {@link size} bytes to the buffer and returns its offset.
     */
    reserveUnsafe(size: number): number;
    private join;
    flush(code?: number): Buffer;
    clear(): void;
}
