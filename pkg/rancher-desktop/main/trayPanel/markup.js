const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const canvas = document.getElementById('canvas');
const context = canvas.getContext('2d');
const file = new URLSearchParams(window.location.search).get('file');
const image = new window.Image();
let tool = 'arrow';
let start = null;
let snapshot = null;

function point(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
}

function drawArrow(from, to) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x); const head = Math.max(12, canvas.width / 80);
  context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
  context.moveTo(to.x, to.y); context.lineTo(to.x - head * Math.cos(angle - Math.PI / 6), to.y - head * Math.sin(angle - Math.PI / 6));
  context.moveTo(to.x, to.y); context.lineTo(to.x - head * Math.cos(angle + Math.PI / 6), to.y - head * Math.sin(angle + Math.PI / 6));
  context.stroke();
}

function draw(toolName, from, to, commit) {
  context.putImageData(snapshot, 0, 0); context.strokeStyle = '#d9403a'; context.fillStyle = '#d9403a'; context.lineWidth = Math.max(3, canvas.width / 450); context.lineCap = 'round'; context.lineJoin = 'round';
  if (toolName === 'arrow') drawArrow(from, to);
  if (toolName === 'box') context.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y);
  if (toolName === 'blur' && commit) {
    const x = Math.min(from.x, to.x); const y = Math.min(from.y, to.y); const width = Math.abs(to.x - from.x); const height = Math.abs(to.y - from.y);
    if (width > 2 && height > 2) { const copy = document.createElement('canvas'); copy.width = width; copy.height = height; const copyContext = copy.getContext('2d'); copyContext.filter = `blur(${ Math.max(8, canvas.width / 120) }px)`; copyContext.drawImage(canvas, x, y, width, height, 0, 0, width, height); context.drawImage(copy, x, y) }
  } else if (toolName === 'blur') { context.setLineDash([8, 6]); context.strokeRect(from.x, from.y, to.x - from.x, to.y - from.y); context.setLineDash([]) }
}

canvas.addEventListener('pointerdown', event => {
  const current = point(event);
  if (tool === 'text') {
    const value = window.prompt('Text to add');
    if (value) { context.fillStyle = '#d9403a'; context.font = `600 ${ Math.max(20, canvas.width / 32) }px -apple-system`; context.fillText(value, current.x, current.y) }
    return;
  }
  start = current; snapshot = context.getImageData(0, 0, canvas.width, canvas.height); canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => { if (start) draw(tool, start, point(event), false); });
canvas.addEventListener('pointerup', event => { if (start) draw(tool, start, point(event), true); start = null; snapshot = null });
document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => { tool = button.dataset.tool; document.querySelectorAll('[data-tool]').forEach(item => item.classList.toggle('on', item === button)) }));
document.getElementById('cancel').addEventListener('click', () => window.close());
document.getElementById('save').addEventListener('click', () => {
  const encoded = canvas.toDataURL('image/png').split(',')[1]; fs.writeFileSync(file, Buffer.from(encoded, 'base64')); document.getElementById('status').textContent = 'Saved to Sulla Files'; setTimeout(() => window.close(), 450);
});
image.onload = () => { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; context.drawImage(image, 0, 0) };
image.onerror = () => { document.getElementById('status').textContent = 'Could not open screenshot' };
image.src = pathToFileURL(file).href;
