export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
  setTimeout(() => link.click(), 30);
  setTimeout(() => URL.revokeObjectURL(url), 45_000);
}
