/** Deterministic two-page PDF with colored rectangles, selectable text, and an explicit xref table. */
/**
 * @param userUnit - Page-coordinate unit size as a multiple of 1/72 inch.
 * @param rotation - Clockwise page rotation in degrees.
 * @returns complete PDF bytes; no clocks, external fonts, images, or network references.
 */
export declare function pdfFixture(userUnit?: number, rotation?: number): Uint8Array
/** @returns a journal-like page with table cells, spaced text fragments, and blank regions for drag selection. */
export declare function selectionPdfFixture(): Uint8Array
//# sourceMappingURL=pdf-fixture.d.ts.map
