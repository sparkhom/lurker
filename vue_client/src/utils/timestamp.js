const TOKEN_RE = /YYYY|MM|DD|HH|mm|ss/g;

export function formatTimestamp(iso, fmt) {
  if (!iso || !fmt) return '';
  const d = new Date(iso);
  const tokens = {
    YYYY: String(d.getFullYear()),
    MM: String(d.getMonth() + 1).padStart(2, '0'),
    DD: String(d.getDate()).padStart(2, '0'),
    HH: String(d.getHours()).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
    ss: String(d.getSeconds()).padStart(2, '0'),
  };
  return fmt.replace(TOKEN_RE, (t) => tokens[t]);
}
