/**
 * Hands the browser a URL to save as a file, through a link it clicks and
 * removes. A cross origin link's own download name is ignored by browsers,
 * so the server names the file too (Supabase's signed URL download
 * parameter); the name here covers a same origin URL.
 */
export function saveFromUrl(url, fileName) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
