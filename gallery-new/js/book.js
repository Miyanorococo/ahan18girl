/**
 * Book view mixin for Alpine.js gallery component.
 * A "Book" = experiments from the same date + prompt prefix (= one batch job).
 * Browse pages in story order with model/seed switching.
 * Includes Editor/Timeline mode for selecting best images per page and exporting.
 */
function bookMixin() {
  return {
    book: {
      // Book list
      books: [],          // [{id, date, prefix, theme, modelCount, pageCount}]

      // Current book
      currentBook: null,
      pages: [],          // [{id, prompt_id, scene, models: [{model, images}]}]
      currentPage: 0,
      selectedModel: '',
      selectedSeed: '',
      allModels: [],
      allSeeds: [],
      loading: false,

      // Editor mode
      editorMode: false,
      selections: {},     // pageId -> {model, seed, full_url, thumb_url, name}
      exporting: false,
      exportProgress: '',
    },

    /**
     * Initialize Book list. Groups experiments by date + prompt prefix = one book.
     */
    async initBookList() {
      this.book.loading = true;
      this.book.currentBook = null;
      this.book.pages = [];

      await this.loadExperiments();

      // Group experiments by date + prefix -> books
      // experiment.id format: "20260216_model/S08a_sex1_before"
      // date = first 8 chars of id, prefix = first letter(s) of prompt_id before digits
      const bookMap = {};

      for (const exp of this.experiments) {
        const pid = exp.prompt_id || '';
        if (!pid) continue;

        // Extract date from experiment id (e.g., "20260216_animagine-xl-4.0/S08a_...")
        const dateMatch = exp.id.match(/^(\d{8})_/);
        if (!dateMatch) continue;
        const date = dateMatch[1];

        // Extract book ID: "0216a_S00_cover" -> bookId="0216a", or legacy "S00_cover" -> bookId="S"
        const bookIdMatch = pid.match(/^(\d{4}[a-z])_/);
        let bookId;
        if (bookIdMatch) {
          bookId = bookIdMatch[1]; // new format: 0216a
        } else {
          // Legacy: group by letter prefix (S, SQ, etc.)
          const prefixMatch = pid.match(/^([A-Za-z]+)\d/);
          if (!prefixMatch) continue;
          bookId = prefixMatch[1];
        }

        const bookKey = `${date}_${bookId}`;
        if (!bookMap[bookKey]) {
          bookMap[bookKey] = {
            id: bookKey,
            date,
            bookId,
            _models: new Set(),
            _scenes: new Set(),
            _exps: [],
          };
        }
        bookMap[bookKey]._models.add(exp.model);
        bookMap[bookKey]._scenes.add(pid);
        bookMap[bookKey]._exps.push(exp);
      }

      // Build book list - only books with proper book ID (0216a format) or S prefix
      const testPrefixes = new Set(['UP', 'P', 'FS', 'DY', 'SQ', 'CG', 'NR', 'TN', 'SM', 'R']);
      const books = [];
      for (const b of Object.values(bookMap)) {
        if (b._scenes.size < 2) continue;
        if (testPrefixes.has(b.bookId)) continue;

        // Detect theme from prompt summaries
        const summaries = b._exps.map(e => e.prompt_summary || '').filter(Boolean);
        const genres = b._exps.map(e => (e.genre || '').toLowerCase()).filter(Boolean);
        const topGenre = this._mostCommon(genres) || '';
        const topSummary = this._mostCommon(summaries) || '';

        // Theme name from prefix
        const themeNames = {
          'S': 'ストーリー本編',
          'SQ': '潮吹き',
          'CG': '騎乗位',
          'FS': 'fucked silly',
          'DY': 'dynamic pose',
          'UP': '統一プロンプト',
          'P': 'モデル評価',
          'NR': 'ナース',
          'TN': '触手',
          'SM': 'SMプレイ',
        };
        const theme = themeNames[b.bookId] || topGenre || b.bookId;

        // Find cover thumbnail (first scene sorted by prompt_id)
        const sortedExps = [...b._exps].sort((a, b) => (a.prompt_id || '').localeCompare(b.prompt_id || ''));
        const coverExp = sortedExps[0];
        const coverThumb = coverExp?.thumbnail || '';

        books.push({
          id: b.id,
          date: b.date,
          dateFormatted: `${b.date.slice(0,4)}/${b.date.slice(4,6)}/${b.date.slice(6,8)}`,
          bookId: b.bookId,
          theme,
          genre: topGenre,
          modelCount: b._models.size,
          pageCount: b._scenes.size,
          imageCount: b._exps.length,
          coverThumb,
        });
      }

      // Sort by date desc, then prefix
      books.sort((a, b) => {
        const d = b.date.localeCompare(a.date);
        return d !== 0 ? d : a.bookId.localeCompare(b.bookId);
      });

      this.book.books = books;
      this.book.loading = false;
    },

    _mostCommon(arr) {
      const counts = {};
      for (const v of arr) counts[v] = (counts[v] || 0) + 1;
      let best = '', bestCount = 0;
      for (const [v, c] of Object.entries(counts)) {
        if (c > bestCount) { best = v; bestCount = c; }
      }
      return best;
    },

    /**
     * Open a specific book. Loads all pages for that date+prefix.
     */
    async openBook(bookKey) {
      this.book.loading = true;
      const bookInfo = this.book.books.find(b => b.id === bookKey);
      if (!bookInfo) { this.book.loading = false; return; }

      this.book.currentBook = bookInfo;
      const { date, bookId } = bookInfo;

      // Filter experiments for this book
      const bookExps = this.experiments.filter(e => {
        const dateMatch = e.id.match(/^(\d{8})_/);
        if (!dateMatch || dateMatch[1] !== date) return false;
        const pid = e.prompt_id || '';
        // Match by book ID
        if (/^\d{4}[a-z]_/.test(pid)) {
          const m = pid.match(/^(\d{4}[a-z])_/);
          return m && m[1] === bookId;
        }
        // Legacy: match by letter prefix
        const m = pid.match(/^([A-Za-z]+)\d/);
        return m && m[1] === bookId;
      });

      // Group by scene
      const sceneMap = {};
      const modelSet = new Set();
      const seedSet = new Set();

      for (const exp of bookExps) {
        const pid = exp.prompt_id || '';
        if (!sceneMap[pid]) sceneMap[pid] = { models: {} };
        modelSet.add(exp.model);
        sceneMap[pid].models[exp.model] = exp;
      }

      const sortedScenes = Object.keys(sceneMap).sort((a, b) => {
        const na = a.replace(/[^0-9a-z]/gi, '');
        const nb = b.replace(/[^0-9a-z]/gi, '');
        return na.localeCompare(nb);
      });

      // Load all experiment details in parallel (fast)
      const allLoadTasks = [];
      for (const pid of sortedScenes) {
        for (const [model, exp] of Object.entries(sceneMap[pid].models)) {
          allLoadTasks.push({ pid, model, exp });
        }
      }

      const loadResults = await Promise.allSettled(
        allLoadTasks.map(async ({ pid, model, exp }) => {
          const detail = await this._loadExperimentCached(exp.id);
          return { pid, model, exp, detail };
        })
      );

      // Build pages from loaded results
      const pageMap = {};
      for (const result of loadResults) {
        if (result.status !== 'fulfilled' || !result.value.detail) continue;
        const { pid, model, exp, detail } = result.value;
        const images = (detail.images || []).map((img, idx) => ({
          ...img, _index: idx,
          _seed: this._extractSeed(img.name),
          _model: model, _experiment: detail, _mgExperiment: detail,
        }));
        for (const img of images) {
          if (img._seed) seedSet.add(img._seed);
        }
        if (!pageMap[pid]) pageMap[pid] = [];
        pageMap[pid].push({ model, experiment: exp, detail, images });
      }

      const pages = [];
      for (const pid of sortedScenes) {
        const pageModels = pageMap[pid] || [];
        if (pageModels.length > 0) {
          pageModels.sort((a, b) => a.model.localeCompare(b.model));
          pages.push({
            id: pid, prompt_id: pid, scene: pid,
            summary: pageModels[0].experiment.prompt_summary || pid,
            models: pageModels,
          });
        }
      }

      this.book.pages = pages;
      this.book.allModels = [...modelSet].sort();
      this.book.allSeeds = [...seedSet].sort((a, b) => parseInt(a) - parseInt(b));
      this.book.selectedModel = this.book.allModels[0] || '';
      this.book.selectedSeed = this.book.allSeeds[0] || '';
      this.book.currentPage = 0;
      this.book.editorMode = false;
      this.book.loading = false;

      // Load saved selections for this book
      this.bookLoadSelections();
    },

    /** Back to book list */
    closeBook() {
      this.book.currentBook = null;
      this.book.pages = [];
      this.book.editorMode = false;
    },

    /** Get current page object */
    bookCurrentPage() {
      return this.book.pages[this.book.currentPage] || null;
    },

    /** Get current image for selected model+seed */
    bookCurrentImage() {
      const page = this.bookCurrentPage();
      if (!page) return null;
      const modelData = page.models.find(m => m.model === this.book.selectedModel);
      if (!modelData) return null;
      if (this.book.selectedSeed) {
        return modelData.images.find(img => img._seed === this.book.selectedSeed) || modelData.images[0];
      }
      return modelData.images[0] || null;
    },

    /** Get all seed images for current model on current page */
    bookSeedImages() {
      const page = this.bookCurrentPage();
      if (!page) return [];
      const modelData = page.models.find(m => m.model === this.book.selectedModel);
      return modelData ? modelData.images : [];
    },

    /** Get experiment detail for current selection */
    bookCurrentExperiment() {
      const page = this.bookCurrentPage();
      if (!page) return null;
      const modelData = page.models.find(m => m.model === this.book.selectedModel);
      return modelData?.detail || null;
    },

    bookPrev() { if (this.book.currentPage > 0) this.book.currentPage--; },
    bookNext() { if (this.book.currentPage < this.book.pages.length - 1) this.book.currentPage++; },
    bookSelectModel(model) { this.book.selectedModel = model; },
    bookSelectSeed(seed) { this.book.selectedSeed = seed; },

    bookOpenLightbox() {
      const images = this.bookSeedImages();
      const idx = images.findIndex(img => img._seed === this.book.selectedSeed);
      const exp = this.bookCurrentExperiment();
      this.openLightbox(Math.max(0, idx), 'book', images, exp);
    },

    // ==========================================
    // Editor / Timeline Methods
    // ==========================================

    /** Toggle editor mode */
    bookToggleEditor() {
      this.book.editorMode = !this.book.editorMode;
    },

    /** Select an image for a specific page in the editor */
    bookSelectImage(pageId, model, seed, img) {
      this.book.selections = {
        ...this.book.selections,
        [pageId]: {
          model,
          seed,
          full_url: img.full_url,
          thumb_url: img.thumb_url,
          name: img.name,
        },
      };
      this.bookSaveSelections();
    },

    /** Remove selection for a page */
    bookDeselectPage(pageId) {
      const newSelections = { ...this.book.selections };
      delete newSelections[pageId];
      this.book.selections = newSelections;
      this.bookSaveSelections();
    },

    /** Get the selected image info for a page */
    bookGetSelection(pageId) {
      return this.book.selections[pageId] || null;
    },

    /** Check if a candidate is the currently selected one for a page */
    bookIsSelectedCandidate(pageId, model, seed) {
      const sel = this.book.selections[pageId];
      if (!sel) return false;
      return sel.model === model && sel.seed === seed;
    },

    /** Count of pages that have a selected image */
    bookSelectionCount() {
      return Object.keys(this.book.selections).length;
    },

    /** Get the preview image for the editor - either selected or current view */
    bookEditorPreviewImage() {
      const page = this.bookCurrentPage();
      if (!page) return null;
      const sel = this.book.selections[page.id];
      if (sel) return sel;
      // Fallback to current model+seed image
      return this.bookCurrentImage();
    },

    /** Get all candidate images for current page (all model x seed combinations) */
    bookEditorCandidates() {
      const page = this.bookCurrentPage();
      if (!page) return [];
      const candidates = [];
      for (const modelData of page.models) {
        for (const img of modelData.images) {
          candidates.push({
            model: modelData.model,
            seed: img._seed || '?',
            img,
            full_url: img.full_url,
            thumb_url: img.thumb_url,
            name: img.name,
          });
        }
      }
      return candidates;
    },

    /** Get candidates grouped by model for better display */
    bookEditorCandidatesByModel() {
      const page = this.bookCurrentPage();
      if (!page) return [];
      return page.models.map(modelData => ({
        model: modelData.model,
        images: modelData.images.map(img => ({
          model: modelData.model,
          seed: img._seed || '?',
          img,
          detail: modelData.detail,
        })),
      }));
    },

    /** Get the thumbnail for a timeline slot (selected image or first available) */
    bookTimelineThumb(page) {
      const sel = this.book.selections[page.id];
      if (sel) return sel.thumb_url;
      // Fallback: first image of first model
      const firstModel = page.models[0];
      return firstModel?.images[0]?.thumb_url || '';
    },

    /** Auto-select: for each page, pick the highest-rated image (or first) */
    bookAutoSelect() {
      for (const page of this.book.pages) {
        // Skip pages that already have a selection
        if (this.book.selections[page.id]) continue;

        let bestImg = null;
        let bestModel = '';
        let bestScore = -Infinity;

        for (const modelData of page.models) {
          for (const img of modelData.images) {
            const rating = this.getImageRating(img);
            const aesthetic = this.getAestheticScore(img) || 0;
            // Prefer human rating, then AI score
            const score = rating ? rating * 100 : aesthetic * 50;
            if (score > bestScore) {
              bestScore = score;
              bestImg = img;
              bestModel = modelData.model;
            }
          }
        }

        if (bestImg) {
          this.bookSelectImage(page.id, bestModel, bestImg._seed || '', bestImg);
        }
      }
    },

    /** Clear all selections for the current book */
    bookClearSelections() {
      if (!confirm('Clear all selections for this book?')) return;
      this.book.selections = {};
      this.bookSaveSelections();
    },

    /** Load selections from localStorage */
    bookLoadSelections() {
      try {
        const stored = JSON.parse(localStorage.getItem('book_selections') || '{}');
        const bookKey = this.book.currentBook?.id;
        if (bookKey && stored[bookKey]) {
          this.book.selections = stored[bookKey];
        } else {
          this.book.selections = {};
        }
      } catch {
        this.book.selections = {};
      }
    },

    /** Save selections to localStorage */
    bookSaveSelections() {
      try {
        const stored = JSON.parse(localStorage.getItem('book_selections') || '{}');
        const bookKey = this.book.currentBook?.id;
        if (bookKey) {
          stored[bookKey] = this.book.selections;
          localStorage.setItem('book_selections', JSON.stringify(stored));
        }
      } catch (e) {
        console.error('Failed to save book selections:', e);
      }
    },

    // ==========================================
    // Drag & Drop Methods
    // ==========================================

    /** Start dragging a candidate image */
    bookDragStartCandidate(event, model, seed, img) {
      const pageId = this.bookCurrentPage()?.id;
      if (!pageId) return;
      const data = {
        type: 'candidate',
        pageId,
        model,
        seed,
        full_url: img.full_url,
        thumb_url: img.thumb_url,
        name: img.name,
      };
      event.dataTransfer.setData('text/plain', JSON.stringify(data));
      event.dataTransfer.effectAllowed = 'copy';

      // Create a small drag ghost from the thumbnail
      const ghost = document.createElement('img');
      ghost.src = img.thumb_url;
      ghost.style.width = '60px';
      ghost.style.height = '90px';
      ghost.style.objectFit = 'cover';
      ghost.style.borderRadius = '4px';
      ghost.style.opacity = '0.9';
      ghost.style.position = 'absolute';
      ghost.style.top = '-9999px';
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 30, 45);
      // Clean up ghost element after drag starts
      requestAnimationFrame(() => document.body.removeChild(ghost));
    },

    /** Start dragging a timeline slot (for reorder) */
    bookDragStartTimeline(event, pageIdx) {
      const data = {
        type: 'timeline',
        fromIdx: pageIdx,
      };
      event.dataTransfer.setData('text/plain', JSON.stringify(data));
      event.dataTransfer.effectAllowed = 'move';
    },

    /** Handle drop on a timeline slot */
    bookHandleTimelineDrop(event, targetIdx) {
      event.preventDefault();
      const el = event.currentTarget;
      el.classList.remove('drag-over');

      let data;
      try {
        data = JSON.parse(event.dataTransfer.getData('text/plain'));
      } catch { return; }

      if (data.type === 'candidate') {
        // Candidate dropped on timeline slot -> select image for that page
        const targetPage = this.book.pages[targetIdx];
        if (!targetPage) return;
        this.bookSelectImage(targetPage.id, data.model, data.seed, {
          full_url: data.full_url,
          thumb_url: data.thumb_url,
          name: data.name,
        });
      } else if (data.type === 'timeline') {
        // Timeline slot dropped on another slot -> swap pages
        const fromIdx = data.fromIdx;
        if (fromIdx === targetIdx) return;
        this.bookHandleTimelineReorder(fromIdx, targetIdx);
      }
    },

    /** Handle drop on the preview area */
    bookHandlePreviewDrop(event) {
      event.preventDefault();
      const el = event.currentTarget;
      el.classList.remove('drag-over');

      let data;
      try {
        data = JSON.parse(event.dataTransfer.getData('text/plain'));
      } catch { return; }

      if (data.type === 'candidate') {
        const page = this.bookCurrentPage();
        if (!page) return;
        this.bookSelectImage(page.id, data.model, data.seed, {
          full_url: data.full_url,
          thumb_url: data.thumb_url,
          name: data.name,
        });
      }
    },

    /** Swap two pages in the book.pages array */
    bookHandleTimelineReorder(fromIdx, toIdx) {
      const pages = [...this.book.pages];
      // Swap the two pages
      const temp = pages[fromIdx];
      pages[fromIdx] = pages[toIdx];
      pages[toIdx] = temp;
      // Reassign to trigger Alpine reactivity
      this.book.pages = pages;

      // Update currentPage to follow the dragged page
      if (this.book.currentPage === fromIdx) {
        this.book.currentPage = toIdx;
      } else if (this.book.currentPage === toIdx) {
        this.book.currentPage = fromIdx;
      }
    },

    /** Drag enter handler for drop targets (adds visual indicator) */
    bookDragEnter(event) {
      event.preventDefault();
      event.currentTarget.classList.add('drag-over');
    },

    /** Drag leave handler for drop targets (removes visual indicator) */
    bookDragLeave(event) {
      event.preventDefault();
      // Only remove if we're actually leaving the element, not entering a child
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        event.currentTarget.classList.remove('drag-over');
      }
    },

    /** Get a short display name for a page ID */
    bookShortPageId(pageId) {
      // "0216a_S00_cover" -> "S00"
      const match = pageId.match(/(S\d+[a-z]?)/i);
      return match ? match[1] : pageId.slice(-6);
    },

    // ==========================================
    // Export Methods
    // ==========================================

    /** Ensure jsPDF library is loaded */
    async _ensureJsPDF() {
      if (window.jspdf) return;
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    },

    /** Ensure JSZip library is loaded */
    async _ensureJSZip() {
      if (window.JSZip) return;
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    },

    /** Fetch an image and return as a data URL */
    async _fetchImageAsDataURL(url) {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    },

    /** Fetch an image and return as blob */
    async _fetchImageAsBlob(url) {
      const response = await fetch(url);
      return response.blob();
    },

    /** Get an image's natural dimensions */
    _getImageDimensions(dataUrl) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ width: 1024, height: 1536 }); // default portrait
        img.src = dataUrl;
      });
    },

    /** Export selected images as PDF (one image per page, full bleed) */
    async bookExportPDF() {
      const selectedPages = this.book.pages.filter(p => this.book.selections[p.id]);
      if (selectedPages.length === 0) {
        alert('No pages selected. Please select images first.');
        return;
      }

      this.book.exporting = true;
      this.book.exportProgress = 'Loading jsPDF...';

      try {
        await this._ensureJsPDF();
        const { jsPDF } = window.jspdf;

        // We'll determine page size from the first image
        this.book.exportProgress = `Loading images (0/${selectedPages.length})...`;

        let pdf = null;

        for (let i = 0; i < selectedPages.length; i++) {
          const page = selectedPages[i];
          const sel = this.book.selections[page.id];
          this.book.exportProgress = `Loading images (${i + 1}/${selectedPages.length})...`;

          const dataUrl = await this._fetchImageAsDataURL(sel.full_url);
          const dims = await this._getImageDimensions(dataUrl);

          // Determine orientation based on image aspect ratio
          const isLandscape = dims.width > dims.height;
          const orientation = isLandscape ? 'landscape' : 'portrait';

          // Use A4-like proportions but sized to image aspect ratio
          // PDF page in mm, using 210x297 (A4) as base
          const pageWidth = isLandscape ? 297 : 210;
          const pageHeight = isLandscape ? 210 : 297;

          // Calculate image placement to fill the page
          const imgRatio = dims.width / dims.height;
          const pageRatio = pageWidth / pageHeight;

          let imgW, imgH, imgX, imgY;
          if (imgRatio > pageRatio) {
            // Image is wider than page - fit to width, center vertically
            imgW = pageWidth;
            imgH = pageWidth / imgRatio;
            imgX = 0;
            imgY = (pageHeight - imgH) / 2;
          } else {
            // Image is taller than page - fit to height, center horizontally
            imgH = pageHeight;
            imgW = pageHeight * imgRatio;
            imgX = (pageWidth - imgW) / 2;
            imgY = 0;
          }

          if (i === 0) {
            pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
          } else {
            pdf.addPage('a4', orientation);
          }

          // Set black background
          pdf.setFillColor(0, 0, 0);
          pdf.rect(0, 0, pageWidth, pageHeight, 'F');

          // Detect image format from data URL
          const format = dataUrl.includes('data:image/png') ? 'PNG' : 'JPEG';
          pdf.addImage(dataUrl, format, imgX, imgY, imgW, imgH);
        }

        this.book.exportProgress = 'Generating PDF...';
        const bookName = this.book.currentBook?.theme || 'book';
        pdf.save(`${bookName}.pdf`);

      } catch (e) {
        console.error('PDF export failed:', e);
        alert('PDF export failed: ' + e.message);
      } finally {
        this.book.exporting = false;
        this.book.exportProgress = '';
      }
    },

    /** Export selected images as ZIP */
    async bookExportZip() {
      const selectedPages = this.book.pages.filter(p => this.book.selections[p.id]);
      if (selectedPages.length === 0) {
        alert('No pages selected. Please select images first.');
        return;
      }

      this.book.exporting = true;
      this.book.exportProgress = 'Loading JSZip...';

      try {
        await this._ensureJSZip();
        const zip = new JSZip();

        for (let i = 0; i < selectedPages.length; i++) {
          const page = selectedPages[i];
          const sel = this.book.selections[page.id];
          const pageNum = String(i + 1).padStart(3, '0');
          const shortId = this.bookShortPageId(page.id);
          this.book.exportProgress = `Downloading (${i + 1}/${selectedPages.length})...`;

          const blob = await this._fetchImageAsBlob(sel.full_url);
          // Determine extension from URL or blob type
          const ext = sel.full_url.match(/\.(png|jpg|jpeg|webp)$/i)?.[1] || 'png';
          zip.file(`${pageNum}_${shortId}.${ext}`, blob);
        }

        this.book.exportProgress = 'Creating ZIP...';
        const content = await zip.generateAsync({ type: 'blob' });
        const bookName = this.book.currentBook?.theme || 'book';

        // Trigger download
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = `${bookName}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);

      } catch (e) {
        console.error('ZIP export failed:', e);
        alert('ZIP export failed: ' + e.message);
      } finally {
        this.book.exporting = false;
        this.book.exportProgress = '';
      }
    },

    /** Download the currently displayed editor preview image */
    bookExportCurrentImage() {
      const preview = this.bookEditorPreviewImage();
      if (!preview) return;
      const url = preview.full_url;
      if (!url) return;

      const a = document.createElement('a');
      a.href = url;
      const page = this.bookCurrentPage();
      const shortId = page ? this.bookShortPageId(page.id) : 'image';
      a.download = `${shortId}.png`;
      a.click();
    },
  };
}
