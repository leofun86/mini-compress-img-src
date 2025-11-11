let selectedFormat = 'webp';

// public/app.js
const $ = (sel, p = document) => p.querySelector(sel);
const $$ = (sel, p = document) => [...p.querySelectorAll(sel)];

const formatEl = $('#format');
const qualityEl = $('#quality');
const qVal = $('#qualityVal');
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const pickBtn = $('#pickBtn');
const queue = $('#queue');
const items = $('#items');
const zipAll = $('#zipAll');
const resetBtn = $('#resetBtn');
const profileRefEl = $('#profileRef');

qVal.textContent = qualityEl.value;
qualityEl.addEventListener('input', () => qVal.textContent = qualityEl.value);

pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFiles([...e.target.files]));

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('hover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('hover'));
dropzone.addEventListener('drop', e => {
  e.preventDefault(); dropzone.classList.remove('hover');
  const files = [...e.dataTransfer.files]; // no filtramos para poder mostrar errores
  handleFiles(files);
});

resetBtn.addEventListener('click', () => {
  items.innerHTML = '';
  queue.classList.add('hidden');
  zipAll.classList.add('hidden');
  zipAll.removeAttribute('href');
});

function addItem(file) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `
    <div class="thumb"></div>
    <div class="meta">
      <div class="name">${file.name}</div>
      <div class="sizes"><span class="orig">${pretty(file.size || 0)}</span> → <span class="out">—</span> <span class="badge" style="display:none;"></span></div>
    </div>
    <div class="progress"><div></div></div>
    <div class="actions">
      <a class="dl" download>Descargar</a>
    </div>
  `;
  // Si es imagen, generar preview
  if (file.type && file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = () => { li.__originalDataURL = reader.result; originalPreviews.set(file.name, reader.result);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const s = 56;
        const r = Math.min(s / img.width, s / img.height);
        canvas.width = s; canvas.height = s;
        const w = img.width * r, h = img.height * r;
        ctx.drawImage(img, (s - w)/2, (s - h)/2, w, h);
        li.querySelector('.thumb').innerHTML = '';
        li.querySelector('.thumb').appendChild(canvas);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  } else {
    li.querySelector('.thumb').textContent = '—';
  }
  items.appendChild(li);
  return li;
}

function pretty(bytes) {
  if (!bytes) return '—';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes)/Math.log(k));
  return parseFloat((bytes/Math.pow(k,i)).toFixed(2)) + ' ' + sizes[i];
}

// --- Modal helpers ---
const modal = $('#errorModal');
const modalFriendly = modal ? modal.querySelector('.friendly') : null;
const modalTech = modal ? modal.querySelector('.technical') : null;
const closeModalBtn = modal ? modal.querySelector('#closeModal') : null;

function openModal(friendly, technical) {
  if (!modal) return;
  modalFriendly.textContent = friendly || 'Ocurrió un error.';
  modalTech.textContent = technical || '';
  modal.classList.remove('hidden');
  modal.classList.add('show');
  document.body.classList.add('modal-open');
}
function closeModal() {
  if (!modal) return;
  modal.classList.remove('show');
  setTimeout(() => modal.classList.add('hidden'), 200);
  document.body.classList.remove('modal-open');
}
if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// Track total files per batch
let currentBatchTotal = 0;
function resetBatchState() { currentBatchTotal = 0; }

// Map rows by name to update
const rowByName = new Map();

const __originalAddItem = addItem;
addItem = function(file) {
  const li = __originalAddItem(file);
  rowByName.set(file.name, li);
  return li;
}

async function handleFiles(files) {
  if (!files.length) return;
  queue.classList.remove('hidden');
  resetBatchState();
  currentBatchTotal = files.length;

  const form = new FormData();
  files.forEach(f => form.append('images', f));
  form.append('format', formatEl.value);
  form.append('quality', qualityEl.value);
  if (profileRefEl.files[0]) form.append('profileRef', profileRefEl.files[0]);

  const rows = files.map(addItem);

  // Fake progress bars
  const timers = rows.map(row => {
    const bar = row.querySelector('.progress > div');
    let p = 0;
    const t = setInterval(() => {
      if (p < 95) { p += Math.random()*8; bar.style.width = Math.min(95, p) + '%'; }
    }, 180);
    return { row, bar, t };
  });

  let successes = 0;
  let processed = 0;

  try {
    const res = await fetch('/api/compress', { method: 'POST', body: form });
    const data = await res.json();

    // Success results
    (data.results || []).forEach((r, i) => {
      const row = rowByName.get(r.originalName) || timers[i]?.row;
      const bar = row.querySelector('.progress > div');
      const sizes = row.querySelector('.sizes .out');
      clearInterval(timers[i]?.t);
      if (bar) bar.style.width = '100%';
      sizes.textContent = pretty(r.outputBytes);

      const a = row.querySelector('a.dl');
      a.style.display = 'inline-block';
      a.href = r.url;
      a.download = r.outputName;
      a.textContent = 'Descargar';
      const actions = row.querySelector('.actions');
      const btnCompare = document.createElement('button');
      btnCompare.className = 'btn secondary';
      btnCompare.textContent = 'Antes/después';
      btnCompare.addEventListener('click', () => { const originalData = originalPreviews.get(r.originalName) || row.__originalDataURL || ''; openCompare(originalData, r.url); });
      actions.appendChild(btnCompare);
      row.__compressedURL = r.url;

      processed++; successes++;
    });

    // Per-file errors
    (data.errors || []).forEach(err => {
      const row = rowByName.get(err.file);
      if (!row) return;
      row.classList.add('error');
      const bar = row.querySelector('.progress > div');
      if (bar) bar.style.width = '0%';
      const sizes = row.querySelector('.sizes .out');
      if (sizes) sizes.textContent = '—';

      const actions = row.querySelector('.actions');
      const btn = document.createElement('button');
      btn.className = 'btn-error';
      btn.textContent = 'Ver error';
      btn.addEventListener('click', () => openModal(err.friendly, err.technical));
      actions.appendChild(btn);

      const badge = row.querySelector('.badge');
      if (badge) { badge.style.display = ''; badge.textContent = '⚠️ Error'; badge.classList.add('error-badge'); }
      processed++;
    });

    // ZIP visible solo al terminar todo y si hubo al menos 1 éxito
    const showZip = processed >= currentBatchTotal && successes > 0 && data.zipUrl;
    if (showZip) {
      zipAll.classList.remove('hidden');
      zipAll.href = data.zipUrl;
    } else {
      zipAll.classList.add('hidden');
      zipAll.removeAttribute('href');
    }
  } catch (e) {
    console.error(e);
    openModal('Ocurrió un error general. Intentá nuevamente.', String(e && e.message || e));
  } finally {
    timers.forEach(({t}) => clearInterval(t));
    rowByName.clear();
  }
}


// --- Mapa de previsualizaciones originales ---
const originalPreviews = new Map();

// --- Modal comparación antes/después ---
const compareModal = document.getElementById('compareModal');
const compareBefore = document.getElementById('compareBefore');
const compareAfter = document.getElementById('compareAfter');
const compareSlider = document.getElementById('compareSlider');
const closeCompareBtn = document.getElementById('closeCompare');

function openCompare(originalDataUrl, compressedUrl) {
  if (!compareModal) return;
  compareBefore.src = originalDataUrl;
  compareAfter.src = compressedUrl;
  compareBefore.style.opacity = 0;
  compareAfter.style.opacity = 0;
  setTimeout(() => {
    compareBefore.style.transition = 'opacity .4s';
    compareAfter.style.transition = 'opacity .4s';
    compareBefore.style.opacity = 1;
    compareAfter.style.opacity = 1;
  }, 50);
  compareModal.classList.remove('hidden');
  compareModal.classList.add('show');
  document.body.classList.add('modal-open');
  setTimeout(initCompareSlider, 100);
}

function closeCompare() {
  if (!compareModal) return;
  compareModal.classList.remove('show');
  setTimeout(() => compareModal.classList.add('hidden'), 200);
  document.body.classList.remove('modal-open');
}
if (closeCompareBtn) closeCompareBtn.addEventListener('click', closeCompare);
if (compareModal) compareModal.addEventListener('click', e => { if (e.target === compareModal) closeCompare(); });

function initCompareSlider() {
  const container = compareModal.querySelector('.compare-container');
  const afterWrap = compareModal.querySelector('.compare-img.after');
  let dragging = false;

  function move(x) {
    const rect = container.getBoundingClientRect();
    let pos = Math.max(0, Math.min(x - rect.left, rect.width));
    const percent = (pos / rect.width) * 100;
    afterWrap.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
    compareSlider.style.left = percent + '%';
  }

  compareSlider.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); });
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('mousemove', e => { if (dragging) move(e.clientX); });
}


// --- Animated slider intro and pulsing effect ---
function animateSliderIntro() {
  const afterWrap = compareModal.querySelector('.compare-img.after');
  const slider = compareSlider;
  const duration = 1500;
  const start = performance.now();
  const animate = (time) => {
    const progress = (time - start) / duration;
    if (progress <= 1) {
      const wave = 50 - 15 * Math.sin(progress * Math.PI);
      afterWrap.style.clipPath = `inset(0 ${100 - wave}% 0 0)`;
      slider.style.left = wave + '%';
      requestAnimationFrame(animate);
    }
  };
  requestAnimationFrame(animate);
}

// integrate animation in openCompare
const __oldOpenCompare = openCompare;
openCompare = function(originalDataUrl, compressedUrl) {
  if (!compareModal) return;
  compareBefore.src = originalDataUrl;
  compareAfter.src = compressedUrl;
  compareModal.classList.remove('hidden');
  compareModal.classList.add('show');
  document.body.classList.add('modal-open');
  setCompareContainerHeight();
  [compareBefore, compareAfter].forEach(img => {
    img.addEventListener('load', () => img.style.opacity = 1, { once: true });
  });
  setTimeout(() => {
    initCompareSlider();
    animateSliderIntro();
  }, 200);
}


// --- Ajustar altura del contenedor de comparación de forma responsiva ---
function setCompareContainerHeight() {
  const container = compareModal.querySelector('.compare-container');
  if (!container) return;

  const checkImg = () => {
    if (!compareBefore.naturalWidth) return;
    const ratio = container.clientWidth / compareBefore.naturalWidth;
    const height = compareBefore.naturalHeight * ratio;
    container.style.height = height + 'px';
  };

  if (compareBefore.complete && compareAfter.complete) {
    checkImg();
  } else {
    let loaded = 0;
    [compareBefore, compareAfter].forEach(img => {
      img.addEventListener('load', () => {
        loaded++;
        if (loaded === 2) checkImg();
      }, { once: true });
    });
  }

  // Ajuste responsivo
  window.addEventListener('resize', checkImg);
}


// --- Zoom control ---
const zoomRange = document.getElementById('zoomRange');
if (zoomRange) {
  zoomRange.addEventListener('input', e => {
    const scale = parseFloat(e.target.value);
    compareBefore.style.transform = `scale(${scale})`;
    compareAfter.style.transform = `scale(${scale})`;
  });
}


// --- Pan con sliders ---
const panControls = document.querySelector('.pan-controls');
const panX = document.getElementById('panX');
const panY = document.getElementById('panY');
let currentScale = 1;


const updateTransform = () => {
  const container = compareModal.querySelector('.compare-container');
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const imgW = compareBefore.naturalWidth * currentScale;
  const imgH = compareBefore.naturalHeight * currentScale;

  // Límite máximo en píxeles para mantener visible dentro del container
  const maxOffsetX = Math.max(0, (imgW - rect.width) / (2 * currentScale));
  const maxOffsetY = Math.max(0, (imgH - rect.height) / (2 * currentScale));

  // Escalar el rango de -100 a +100 en base a límites calculados
  const offsetX = (panX.value / 100) * maxOffsetX;
  const offsetY = (panY.value / 100) * maxOffsetY;

  // Clamp para evitar salir del contenedor
  const clampedX = Math.min(Math.max(offsetX, -maxOffsetX), maxOffsetX);
  const clampedY = Math.min(Math.max(offsetY, -maxOffsetY), maxOffsetY);

  // Aplicar transformaciones sincronizadas
  [compareBefore, compareAfter].forEach(img => {
    img.style.transform = `translate(${clampedX}px, ${clampedY}px) scale(${currentScale})`;
  });
};


// Sliders sync
if (panX && panY) {
  panX.addEventListener('input', updateTransform);
  panY.addEventListener('input', updateTransform);
}

// Show/hide controls based on zoom
if (zoomRange) {
  zoomRange.addEventListener('input', e => {
    currentScale = parseFloat(e.target.value);
    if (currentScale > 1.01) {
      panControls.classList.remove('hidden');
    } else {
      panControls.classList.add('hidden');
      panX.value = 0;
      panY.value = 0;
    }
    updateTransform();
  });
}


let __batchFiles = [];

async function sendToServer(file, formOverride){
  const form = new FormData();
  form.append('file', file);
  form.append('format', (typeof selectedFormat !== 'undefined' ? selectedFormat : 'webp'));
  try{
    const resp = await fetch('/api/compress', { method: 'POST', body: form });
    const data = await resp.json();
    if (data && data.ok){
      __batchFiles.push(data.filename);
      return data;
    } else {
      return { ok:false, error: (data && data.error) || 'Error desconocido' };
    }
  }catch(e){
    return { ok:false, error: e.message };
  }
}

async function requestZip() {
  if (!__batchFiles.length) return null;
  try{
    const resp = await fetch('/api/zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: __batchFiles })
    });
    const data = await resp.json();
    if (data && data.ok) return data.zip;
  }catch(e){ console.error('zip error', e); }
  return null;
}

window.addEventListener('batch:done', async () => {
  const zipUrl = await requestZip();
  if (zipUrl) {
    const el = document.getElementById('zipAll');
    if (el){ el.classList.remove('hidden'); el.href = zipUrl; }
  }
});
