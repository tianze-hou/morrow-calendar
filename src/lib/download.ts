/**
 * 把内存里的 Blob 存成文件。
 *
 * 用 <a download> 而不是 File System Access API：后者只有 Chromium 系支持，
 * 为一次导出写两套分支不划算。用完记得延迟 revoke —— Safari 是异步读这个
 * object URL 的，点完立刻释放会存下一个 0 字节的空文件。
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
