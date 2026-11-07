/**
 * Signature and photo capture.
 *
 * Both are optional paths in the application, and both are built so that a
 * pointer is never the only way through.
 *
 * **Signatures.** Drawing is a dragging interaction. WCAG 2.2 SC 2.5.7 exempts
 * dragging where it is essential, and a handwritten signature arguably
 * qualifies — but leaning on that exemption would gate someone's equipment on
 * their ability to use a pointer. So three methods are offered as equals:
 * draw, type your name as an attestation, or upload a photograph of a wet
 * signature. The tech can also record that it was waived, with a reason.
 *
 * **Photos.** Resized in the browser before upload, because a modern phone
 * camera produces 4–8 MB per shot and a returns desk on hotel wifi should not
 * be sending that.
 */

import { el, clear, field, announce, toastError, toastWarn } from './ui.js';

// ---------------------------------------------------------------------------
// Image resizing
// ---------------------------------------------------------------------------

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Downscale an image file to a JPEG data URL.
 * Returns { data, width, height } so the server can record dimensions without
 * decoding the image itself.
 */
export function resizeImage(file, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.onload = () => {
      const image = new Image();

      image.onerror = () => reject(new Error('That file is not an image this browser can open.'));
      image.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
        const width = Math.round(image.width * scale);
        const height = Math.round(image.height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext('2d');
        // White backdrop: a transparent PNG flattened to JPEG otherwise goes black.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);

        resolve({ data: canvas.toDataURL('image/jpeg', quality), width, height });
      };

      image.src = reader.result;
    };

    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Photo picker
// ---------------------------------------------------------------------------

/**
 * A photo picker with thumbnails and per-item removal.
 *
 * `capture="environment"` makes a phone open the rear camera directly, while
 * still being an ordinary file input on a desktop — so one control covers both
 * without a camera-permission dance.
 */
export function photoPicker({ label = 'Photos', max = 4, help = null } = {}) {
  const id = `photos-${Math.random().toString(36).slice(2, 7)}`;
  const images = [];

  const input = el('input', {
    type: 'file',
    id,
    accept: 'image/*',
    capture: 'environment',
    multiple: true,
    'aria-describedby': `${id}-help ${id}-status`,
  });

  const thumbs = el('ul', {
    class: 'thumb-list',
    'aria-label': 'Photos to be attached',
  });
  const status = el('p', { class: 'field-help', id: `${id}-status`, role: 'status' });

  const renderThumbs = () => {
    clear(thumbs);

    images.forEach((image, index) => {
      thumbs.append(el('li', {}, [
        el('img', { src: image.data, alt: `Photo ${index + 1} of ${images.length}` }),
        el('button', {
          type: 'button',
          class: 'btn btn-sm',
          onClick: () => {
            images.splice(index, 1);
            renderThumbs();
            announce(`Photo ${index + 1} removed. ${images.length} remaining.`);
          },
        }, ['Remove', el('span', { class: 'visually-hidden' }, ` photo ${index + 1}`)]),
      ]));
    });

    status.textContent = images.length
      ? `${images.length} of ${max} photo(s) ready to attach.`
      : 'No photos selected. This is optional.';
  };

  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.value = '';

    for (const file of files) {
      if (images.length >= max) {
        toastWarn(`Only ${max} photos can be attached here.`);
        break;
      }
      try {
        images.push(await resizeImage(file));
      } catch (err) {
        toastError(`${file.name}: ${err.message}`);
      }
    }

    renderThumbs();
    announce(`${images.length} photo(s) selected.`);
  });

  renderThumbs();

  const wrapper = el('div', { class: 'field' }, [
    el('label', { for: id }, label),
    input,
    el('p', {
      class: 'field-help', id: `${id}-help`,
      text: help || `Optional. Up to ${max}. Photos are resized before upload and are only visible to signed-in staff.`,
    }),
    thumbs,
    status,
  ]);

  wrapper.getImages = () => images.map((i) => ({ data: i.data, width: i.width, height: i.height }));
  wrapper.count = () => images.length;

  return wrapper;
}

// ---------------------------------------------------------------------------
// Signature capture
// ---------------------------------------------------------------------------

/**
 * Three equal ways to sign, chosen with radio buttons.
 *
 * Returns an object exposing `value()` which yields
 * `{ signature_method, signature_image?, typed_signature?, waived_reason? }`,
 * or throws a message describing what is still needed.
 */
export function signaturePad({ allowWaive = true, signerName = '' } = {}) {
  const group = `sig-${Math.random().toString(36).slice(2, 7)}`;
  const panels = {};
  let method = 'typed';

  // --- Typed ---------------------------------------------------------------
  const typedField = field({
    name: 'typed_signature',
    label: 'Type your full name',
    value: signerName,
    help: 'Typing your name here has the same effect as signing it.',
    autocomplete: 'name',
  });
  panels.typed = el('div', {}, [typedField]);

  // --- Drawn ---------------------------------------------------------------
  const canvas = el('canvas', {
    class: 'signature-canvas',
    width: 600,
    height: 200,
    role: 'img',
    'aria-label': 'Signature drawing area. If you cannot draw, choose "Type my name" instead.',
  });
  const context = canvas.getContext('2d');
  let hasDrawing = false;

  const resetCanvas = () => {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#111111';
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    hasDrawing = false;
  };
  resetCanvas();

  let drawing = false;

  const pointFrom = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  // Pointer events cover mouse, touch and stylus in one path.
  canvas.addEventListener('pointerdown', (event) => {
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const point = pointFrom(event);
    context.beginPath();
    context.moveTo(point.x, point.y);
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const point = pointFrom(event);
    context.lineTo(point.x, point.y);
    context.stroke();
    hasDrawing = true;
    event.preventDefault();
  });

  const endStroke = () => { drawing = false; };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  panels.drawn = el('div', {}, [
    canvas,
    el('div', { class: 'row', style: { marginTop: '8px' } }, [
      el('button', {
        type: 'button', class: 'btn btn-sm',
        onClick: () => { resetCanvas(); announce('Signature cleared.'); },
      }, 'Clear and start again'),
    ]),
    el('p', {
      class: 'field-help',
      text: 'Sign with a finger, stylus or mouse. If that is difficult, switch to typing your name — it counts the same.',
    }),
  ]);

  // --- Uploaded ------------------------------------------------------------
  const uploadPicker = photoPicker({
    label: 'Photograph of a signed form',
    max: 1,
    help: 'Take a picture of the signed paper copy. Useful when the client signed away from the desk.',
  });
  panels.uploaded = el('div', {}, [uploadPicker]);

  // --- Waived --------------------------------------------------------------
  const waiveField = field({
    name: 'waived_reason',
    label: 'Why is this going out unsigned?',
    type: 'textarea',
    help: 'Recorded on the loan and in the audit log.',
  });
  panels.waived = el('div', {}, [
    el('p', {
      class: 'field-help',
      text: 'Use this only when a signature genuinely cannot be taken now.',
    }),
    waiveField,
  ]);

  // --- Method chooser ------------------------------------------------------
  const panelHost = el('div', { style: { marginTop: '12px' } }, [panels.typed]);

  const showPanel = (next) => {
    method = next;
    clear(panelHost).append(panels[next]);

    const focusTarget = panelHost.querySelector('input, textarea, canvas');
    if (focusTarget && focusTarget.tagName !== 'CANVAS') focusTarget.focus();
    announce(`Signature method: ${METHOD_LABELS[next]}.`);
  };

  const METHOD_LABELS = {
    typed: 'type my name',
    drawn: 'draw a signature',
    uploaded: 'upload a photo of a signed form',
    waived: 'proceed without a signature',
  };

  const options = [
    ['typed', 'Type my name', 'Works with a keyboard alone, and counts as a signature.'],
    ['drawn', 'Draw a signature', 'Sign with a finger, stylus or mouse.'],
    ['uploaded', 'Upload a photo of a signed form', 'For a signature taken on paper.'],
  ];
  if (allowWaive) {
    options.push(['waived', 'Proceed without a signature', 'Requires a reason, and is recorded.']);
  }

  const chooser = el('fieldset', {}, [
    el('legend', {}, 'How would you like to sign?'),
    ...options.map(([value, label, hint]) => {
      const inputId = `${group}-${value}`;
      return el('label', { class: 'radio', for: inputId }, [
        el('input', {
          type: 'radio', name: group, id: inputId, value,
          checked: value === 'typed',
          onChange: () => showPanel(value),
        }),
        el('span', {}, [label, el('span', { class: 'option-help' }, hint)]),
      ]);
    }),
  ]);

  const container = el('div', {}, [chooser, panelHost]);

  /** Throws a human-readable message when the chosen method is incomplete. */
  container.value = () => {
    if (method === 'typed') {
      const typed = typedField.control.value.trim();
      if (!typed) {
        typedField.setError('Type your full name to sign.');
        typedField.control.focus();
        throw new Error('Type your full name to sign.');
      }
      return { signature_method: 'typed', typed_signature: typed };
    }

    if (method === 'drawn') {
      if (!hasDrawing) throw new Error('Draw a signature, or switch to typing your name.');
      return { signature_method: 'drawn', signature_image: canvas.toDataURL('image/png') };
    }

    if (method === 'uploaded') {
      const images = uploadPicker.getImages();
      if (!images.length) throw new Error('Add a photo of the signed form.');
      return { signature_method: 'uploaded', signature_image: images[0].data };
    }

    const reason = waiveField.control.value.trim();
    if (!reason) {
      waiveField.setError('Give a reason for proceeding without a signature.');
      waiveField.control.focus();
      throw new Error('Give a reason for proceeding without a signature.');
    }
    return { signature_method: 'waived', waived_reason: reason };
  };

  container.method = () => method;

  return container;
}
