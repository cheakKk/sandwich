// Progress bar widths come from data-pct (the page's CSP forbids inline style attributes, but setting styles from script is fine).
for (const i of document.querySelectorAll('.bar > i[data-pct]')) i.style.width = i.dataset.pct + '%';
