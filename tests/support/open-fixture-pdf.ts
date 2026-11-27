import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * A document opened by pdf.js, as far as the tests read it. pdf.js 6 has no
 * `PDFDocumentProxy.destroy`; a test releases the document through `loadingTask.destroy()`.
 */
export interface FixturePdfDocument {
  numPages: number;
  getPage: (n: number) => Promise<unknown>;
  loadingTask: { destroy: () => Promise<void> };
}

export async function loadPdfjs(): Promise<{
  getDocument: (params: Record<string, unknown>) => {
    promise: Promise<FixturePdfDocument>;
  };
  OPS: Record<string, number>;
}> {
  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = (await import(pathToFileURL(pdfjsPath).href)) as {
    getDocument: (params: Record<string, unknown>) => {
      promise: Promise<FixturePdfDocument>;
    };
    OPS: Record<string, number>;
  };
  return pdfjs;
}

export function standardFontDataUrl(): string {
  const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  return pathToFileURL(resolve(dirname(pdfjsPath), '..', '..', 'standard_fonts') + '/').href;
}

export async function openPdfBytes(bytes: Uint8Array): Promise<FixturePdfDocument> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    standardFontDataUrl: standardFontDataUrl(),
  }).promise;
}
