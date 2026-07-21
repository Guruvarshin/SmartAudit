/** Presentation formatting, kept in one place so the table and modal agree. */
export class Format {
  static money(value, currency) {
    if (value === null || value === undefined) return '—';
    try {
      return new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: currency || 'INR',
        maximumFractionDigits: 2
      }).format(value);
    } catch {
      return `${value} ${currency ?? ''}`.trim();
    }
  }

  static date(value) {
    if (!value) return '—';
    return new Date(value).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    });
  }

  static dateTime(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString();
  }

  static score(value) {
    if (value === null || value === undefined) return '—';
    return value.toFixed(2);
  }

  static truncate(text, max = 60) {
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
}
