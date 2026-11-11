// jsdom (CRA 5 / jest 27) lacks these browser APIs that the file parsers use.
import { TextDecoder, TextEncoder } from 'util';
if (!global.TextDecoder) global.TextDecoder = TextDecoder;
if (!global.TextEncoder) global.TextEncoder = TextEncoder;
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsArrayBuffer(this); });
  };
}
if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Blob.prototype.text = function text() { return this.arrayBuffer().then((b) => new TextDecoder().decode(b)); };
}
