/** Keep raw PDF bytes out of rendered component props while retaining the full tab in app state. */
export function withoutPdfBytes<T extends { bytes: Uint8Array }>(
  value: T,
): Omit<T, "bytes"> {
  const { bytes, ...view } = value;
  void bytes;
  return view;
}
