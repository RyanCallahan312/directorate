const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const encoder = new TextEncoder();

export const decodeUtf8 = (bytes: Uint8Array) => decoder.decode(bytes);
export const encodeUtf8 = (text: string) => encoder.encode(text);
