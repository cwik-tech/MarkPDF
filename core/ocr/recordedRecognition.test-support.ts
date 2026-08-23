/**
 * A recorded recognition of the adversarial fixture's page 10, word for word and box for box.
 *
 * Recorded from the real engine once (Node tesseract.js 7.0.0, LSTM_ONLY, default page
 * segmentation, 200 dpi) so that the reconstruction rules can be tested against what the engine
 * actually returns — not against what its type definitions promise, and not by starting an
 * engine in every test run. The recognition is a property of the fixture: the same fixture and
 * the same contract produce the same boxes.
 *
 * Word bounding boxes carry only the x extent that reconstruction needs; the y extent of a word
 * is its line's. Line order is by y position, top of the page first.
 */

export interface RecordedWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export interface RecordedLine {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  words: RecordedWord[];
}

export interface RecordedBlock {
  paragraphs: { lines: RecordedLine[] }[];
}

/** The worker's result for page 10, exactly as the engine produced it. */
export const RECORDED_PAGE_10_RESULT: { data: { text: string; blocks: RecordedBlock[] } } = {
  data: {
    text:
      "Approved operating plan\n\n" +
      "Line item Approved 2026 Approved 2027 Approved 2028 Approved 2029\n" +
      "Sales & Marketing 4110 4620 5170 5890\n\n" +
      "R&D 3020 3310 3640 3980\n\n" +
      "G&A 1180 1240 1310 1390\n",
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                text: "Approved operating plan",
                bbox: { x0: 76, y0: 127, x1: 567, y1: 171 },
                words: [
                  { text: "Approved", bbox: { x0: 76, y0: 127, x1: 267, y1: 171 } },
                  { text: "operating", bbox: { x0: 283, y0: 127, x1: 469, y1: 171 } },
                  { text: "plan", bbox: { x0: 486, y0: 127, x1: 567, y1: 171 } },
                ],
              },
            ],
          },
          {
            lines: [
              {
                text: "Line item Approved 2026 Approved 2027 Approved 2028 Approved 2029",
                bbox: { x0: 78, y0: 352, x1: 1656, y1: 386 },
                words: [
                  { text: "Line", bbox: { x0: 78, y0: 352, x1: 139, y1: 386 } },
                  { text: "item", bbox: { x0: 151, y0: 352, x1: 212, y1: 386 } },
                  { text: "Approved", bbox: { x0: 605, y0: 352, x1: 748, y1: 386 } },
                  { text: "2026", bbox: { x0: 760, y0: 352, x1: 834, y1: 386 } },
                  { text: "Approved", bbox: { x0: 879, y0: 352, x1: 1022, y1: 386 } },
                  { text: "2027", bbox: { x0: 1034, y0: 352, x1: 1108, y1: 386 } },
                  { text: "Approved", bbox: { x0: 1152, y0: 352, x1: 1296, y1: 386 } },
                  { text: "2028", bbox: { x0: 1308, y0: 352, x1: 1382, y1: 386 } },
                  { text: "Approved", bbox: { x0: 1426, y0: 352, x1: 1570, y1: 386 } },
                  { text: "2029", bbox: { x0: 1582, y0: 352, x1: 1656, y1: 386 } },
                ],
              },
              {
                text: "Sales & Marketing 4110 4620 5170 5890",
                bbox: { x0: 77, y0: 465, x1: 1500, y1: 499 },
                words: [
                  { text: "Sales", bbox: { x0: 77, y0: 465, x1: 159, y1: 499 } },
                  { text: "&", bbox: { x0: 172, y0: 465, x1: 192, y1: 499 } },
                  { text: "Marketing", bbox: { x0: 205, y0: 465, x1: 349, y1: 499 } },
                  { text: "4110", bbox: { x0: 605, y0: 465, x1: 676, y1: 499 } },
                  { text: "4620", bbox: { x0: 879, y0: 465, x1: 952, y1: 499 } },
                  { text: "5170", bbox: { x0: 1154, y0: 465, x1: 1226, y1: 499 } },
                  { text: "5890", bbox: { x0: 1427, y0: 465, x1: 1500, y1: 499 } },
                ],
              },
              {
                text: "R&D 3020 3310 3640 3980",
                bbox: { x0: 79, y0: 560, x1: 1500, y1: 586 },
                words: [
                  { text: "R&D", bbox: { x0: 79, y0: 560, x1: 146, y1: 586 } },
                  { text: "3020", bbox: { x0: 605, y0: 560, x1: 678, y1: 586 } },
                  { text: "3310", bbox: { x0: 879, y0: 560, x1: 952, y1: 586 } },
                  { text: "3640", bbox: { x0: 1153, y0: 560, x1: 1226, y1: 586 } },
                  { text: "3980", bbox: { x0: 1427, y0: 560, x1: 1500, y1: 586 } },
                ],
              },
              {
                text: "G&A 1180 1240 1310 1390",
                bbox: { x0: 77, y0: 654, x1: 1500, y1: 680 },
                words: [
                  { text: "G&A", bbox: { x0: 77, y0: 654, x1: 147, y1: 680 } },
                  { text: "1180", bbox: { x0: 608, y0: 654, x1: 676, y1: 680 } },
                  { text: "1240", bbox: { x0: 882, y0: 654, x1: 952, y1: 680 } },
                  { text: "1310", bbox: { x0: 1156, y0: 654, x1: 1226, y1: 680 } },
                  { text: "1390", bbox: { x0: 1430, y0: 654, x1: 1500, y1: 680 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

/**
 * What the reconstruction of that page must produce, stated from the fixture's own drawing
 * parameters (columns at 80/640/930/1220/1510 on the 1800-wide canvas) rather than from any
 * implementation output.
 */
export const EXPECTED_PAGE_10_MARKDOWN =
  "Approved operating plan\n" +
  "| Line item | Approved 2026 | Approved 2027 | Approved 2028 | Approved 2029 |\n" +
  "| --- | --- | --- | --- | --- |\n" +
  "| Sales & Marketing | 4110 | 4620 | 5170 | 5890 |\n" +
  "| R&D | 3020 | 3310 | 3640 | 3980 |\n" +
  "| G&A | 1180 | 1240 | 1310 | 1390 |";
