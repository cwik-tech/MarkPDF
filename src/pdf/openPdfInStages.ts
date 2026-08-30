export interface StagedPdfOpen<TDocument, TMetadata> {
  loadDocument: () => Promise<TDocument>;
  showDocument: (document: TDocument) => void;
  waitForPaint: () => Promise<void>;
  prepareDocument: (document: TDocument) => Promise<void>;
  loadMetadata: (document: TDocument) => Promise<TMetadata>;
  applyMetadata: (metadata: TMetadata) => void;
}

export type ScheduleUiTurn = (callback: () => void) => void;

/** Yield twice so pending UI work can commit before another document task starts. */
export function yieldToUi(schedule: ScheduleUiTurn): Promise<void> {
  return new Promise<void>((resolve) => {
    schedule(() => schedule(resolve));
  });
}

export async function openPdfInStages<TDocument, TMetadata>(
  input: StagedPdfOpen<TDocument, TMetadata>,
): Promise<TDocument> {
  const document = await input.loadDocument();
  input.showDocument(document);
  await input.waitForPaint();
  await input.prepareDocument(document);
  const metadata = await input.loadMetadata(document);
  input.applyMetadata(metadata);
  return document;
}
