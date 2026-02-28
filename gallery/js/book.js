/**
 * Book view mixin for Alpine.js gallery component.
 * A "Book" = experiments from the same date + prompt prefix (= one batch job).
 * Browse pages in story order with model/seed switching.
 * Includes Editor/Timeline mode for selecting best images per page and exporting.
 *
 * Experiment naming: {bookId}[_R{n}]_{scene}[_{variant}]
 *   bookId:  "0219a"          — MMDD + letter
 *   R{n}:    "R1", "R2"       — Regen generation (omitted = R0 = original)
 *   scene:   "S01c_rain"      — S{num}{sub}_{desc}
 *   variant: "A", "B", "C"    — Variant suffix (omitted = base), max 3 chars
 *
 * openBook() uses 2.5-pass detection to merge variants into base scene pages:
 *   Pass 1:   Collect R0 scene keys as baseScenes
 *   Pass 1.5: Reclassify R0 scenes that are base+"_"+shortSuffix as variants
 *   Pass 2:   Classify each experiment (R0 variant / pure regen / regen variant / new page)
 * See gallery/README.md for full specification.
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

      // Batch Rate (Feature 1)
      selectedPages: [],    // array of page indices for multi-select
      shiftSelecting: false,

      // Smart Suggest (Feature 2)
      suggestion: null,     // {model, count, message} or null

      // Before/After Regen (Feature 3)
      editingPrompt: false,
      editPromptText: '',
      regenFlags: {},       // {pageId: {newPrompt, originalPrompt}}

      // Regeneration workflow (Feature 4)
      regenRunning: false,
      regenStatus: '',
      regenCompleted: false,
      regenArn: '',
      regenPollTimer: null,

      // Save state
      saveStatus: '',         // '' | 'saving' | 'saved' | 'error'
      lastSavedAt: '',        // ISO timestamp of last save

      // Generation versioning (Feature 5)
      generations: [],        // ['R0', 'R2', 'R3'] - detected from loaded pages

      // Undo/Redo
      _undoStack: [],         // Array of state snapshots
      _redoStack: [],

      // Shelf (Feature 6)
      shelf: [],              // Array of page objects removed from timeline
      shelfOpen: false,

      // Variant UI (Feature 7)
      activeVariant: 'base',    // Currently displayed variant
      compareVariant: null,     // DEPRECATED: kept for compat, use comparePanels
      comparePanels: [],        // Array of variant strings for multi-compare (max 10)
    },

    /**
     * Initialize Book list. Groups experiments by date + prompt prefix = one book.
     */
    async initBookList() {
      this.book.loading = true;
      this.book.currentBook = null;
      this.book.pages = [];

      try {
        const data = await GalleryAPI.getBooks();
        const serverBooks = data.books || [];

        // Theme name mapping (UI-only logic)
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

        this.book.books = serverBooks.map(b => ({
          id: b.id,
          date: b.date,
          dateFormatted: b.date ? `${b.date.slice(0,4)}/${b.date.slice(5,7)}/${b.date.slice(8,10)}` : '',
          bookId: b.id,
          theme: themeNames[b.id] || b.genre || b.id,
          genre: b.genre || '',
          modelCount: b.model_count || 0,
          pageCount: b.scene_count || 0,
          imageCount: b.total_experiments || 0,
          coverThumb: b.thumbnail || '',
        }));
      } catch (e) {
        console.error('Failed to load books:', e);
        this.book.books = [];
      }

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
      const { bookId } = bookInfo;

      // Fetch experiments for this book from server
      let bookExps;
      try {
        const data = await GalleryAPI.getExperiments({ book: bookId, limit: 500 });
        bookExps = data.experiments || [];
      } catch (e) {
        console.error('Failed to load book experiments:', e);
        this.book.loading = false;
        return;
      }

      // 2-pass variant detection: merge regen + variant suffixes into base scenes
      // Pass 1: collect base scene keys from R0 experiments
      const allR0Scenes = new Set();
      for (const exp of bookExps) {
        const pid = exp.prompt_id || '';
        const gen = this.bookGetGeneration(pid);
        if (gen === 'R0') {
          allR0Scenes.add(this.bookGetSceneId(pid));
        }
      }

      // Pass 1.5: among R0 scenes, detect variant suffixes
      // e.g. if both S02b_shopping and S02b_shopping_A exist as R0,
      // then S02b_shopping_A is a variant of S02b_shopping
      const baseScenes = new Set();
      const r0VariantMap = {}; // sceneKey → { baseSceneKey, variant }
      const r0Sorted = [...allR0Scenes].sort((a, b) => a.length - b.length); // shorter first
      for (const sk of r0Sorted) {
        let isVariant = false;
        for (const bs of baseScenes) {
          if (sk.startsWith(bs + '_') && sk !== bs) {
            const suffix = sk.slice(bs.length + 1);
            // Only treat as variant if suffix is short (A, B, C, etc.)
            if (suffix.length <= 3) {
              r0VariantMap[sk] = { baseSceneKey: bs, variant: suffix };
              isVariant = true;
              break;
            }
          }
        }
        if (!isVariant) baseScenes.add(sk);
      }

      // Pass 2: classify each experiment
      const sceneMap = {};
      const modelSet = new Set();
      const seedSet = new Set();

      for (const exp of bookExps) {
        const pid = exp.prompt_id || '';
        const gen = this.bookGetGeneration(pid);
        const rawSceneKey = this.bookGetSceneId(pid);
        let baseSceneKey = rawSceneKey;
        let variant = 'base';

        if (gen === 'R0' && r0VariantMap[rawSceneKey]) {
          // R0 experiment that was classified as a variant in Pass 1.5
          baseSceneKey = r0VariantMap[rawSceneKey].baseSceneKey;
          variant = r0VariantMap[rawSceneKey].variant;
        } else if (gen !== 'R0') {
          if (baseScenes.has(rawSceneKey)) {
            // Exact match with a base scene → pure regen, variant="base"
            variant = 'base';
          } else {
            // Try to find a base scene that is a prefix: baseScene + '_' + suffix
            let matched = false;
            for (const bs of baseScenes) {
              if (rawSceneKey.startsWith(bs + '_')) {
                baseSceneKey = bs;
                variant = rawSceneKey.slice(bs.length + 1);
                matched = true;
                break;
              }
            }
            if (!matched) {
              // No matching base scene → treat as new page (variant="base")
              baseSceneKey = rawSceneKey;
              variant = 'base';
            }
          }
        }

        if (!sceneMap[baseSceneKey]) sceneMap[baseSceneKey] = { models: {}, originalPid: pid };
        // Keep the original (non-regen, non-variant) pid as the primary
        if (gen === 'R0' && variant === 'base') sceneMap[baseSceneKey].originalPid = pid;
        // modelGenKey includes variant to keep separate slots
        const modelGenKey = `${exp.model}__${gen}__${variant}`;
        sceneMap[baseSceneKey].models[modelGenKey] = { ...exp, _generation: gen, _variant: variant };
        modelSet.add(exp.model);
      }

      const sortedScenes = Object.keys(sceneMap).sort((a, b) => {
        // Parse S{number}{subletter?}_{description} structurally
        const pa = a.match(/^S(\d+)([a-z]?)(?:_(.*))?$/i);
        const pb = b.match(/^S(\d+)([a-z]?)(?:_(.*))?$/i);
        if (!pa || !pb) return a.localeCompare(b);
        const numA = parseInt(pa[1]), numB = parseInt(pb[1]);
        if (numA !== numB) return numA - numB;
        if ((pa[2] || '') !== (pb[2] || '')) return (pa[2] || '').localeCompare(pb[2] || '');
        return (pa[3] || '').localeCompare(pb[3] || '');
      });

      // Load all experiment details in parallel (fast)
      const allLoadTasks = [];
      for (const sceneKey of sortedScenes) {
        for (const [modelGenKey, exp] of Object.entries(sceneMap[sceneKey].models)) {
          allLoadTasks.push({ sceneKey, pid: sceneMap[sceneKey].originalPid, modelGenKey, model: exp.model, exp });
        }
      }

      const loadResults = await Promise.allSettled(
        allLoadTasks.map(async ({ sceneKey, pid, modelGenKey, model, exp }) => {
          const detail = await this._loadExperimentCached(exp.id);
          return { sceneKey, pid, modelGenKey, model, exp, detail };
        })
      );

      // Build pages from loaded results (regen + variant merged into original pages)
      const pageMap = {};
      for (const result of loadResults) {
        if (result.status !== 'fulfilled' || !result.value.detail) continue;
        const { sceneKey, pid, model, exp, detail } = result.value;
        const images = (detail.images || []).map((img, idx) => ({
          ...img, _index: idx,
          _seed: this._extractSeed(img.name),
          _model: model, _experiment: detail, _mgExperiment: detail,
        }));
        for (const img of images) {
          if (img._seed) seedSet.add(img._seed);
        }
        if (!pageMap[sceneKey]) pageMap[sceneKey] = [];
        pageMap[sceneKey].push({ model, experiment: exp, detail, images, _generation: exp._generation || 'R0', _variant: exp._variant || 'base' });
      }

      const pages = [];
      for (const sceneKey of sortedScenes) {
        const pageModels = pageMap[sceneKey] || [];
        if (pageModels.length > 0) {
          pageModels.sort((a, b) => a.model.localeCompare(b.model));
          const originalPid = sceneMap[sceneKey].originalPid;
          // Collect unique variants for this page, sorted with 'base' first
          const variantSet = new Set(pageModels.map(m => m._variant || 'base'));
          const variants = [...variantSet].sort((a, b) => {
            if (a === 'base') return -1;
            if (b === 'base') return 1;
            return a.localeCompare(b);
          });
          pages.push({
            id: originalPid, prompt_id: originalPid, scene: sceneKey,
            summary: pageModels[0].experiment.prompt_summary || sceneKey,
            models: pageModels,
            variants,
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
      this.book.activeVariant = 'base';
      this.book.compareVariant = null;
      this.book.comparePanels = [];
      this.book.loading = false;

      // Load saved state: try S3 first, fall back to localStorage
      const loadedFromS3 = await this.bookLoadState();
      if (!loadedFromS3) {
        this.bookLoadSelections();
        this._loadRegenFlags();
        this.bookLoadShelf();
      }

      // Detect generations from loaded pages
      this.bookDetectGenerations();
    },

    /** Back to book list */
    closeBook() {
      this.bookStopRegenPoll();
      this.book.currentBook = null;
      this.book.pages = [];
      this.book.editorMode = false;
      this.book.selectedPages = [];
      this.book.suggestion = null;
      this.book.editingPrompt = false;
      this.book.regenFlags = {};
      this.book.regenRunning = false;
      this.book.regenCompleted = false;
      this.book.regenStatus = '';
      this.book.regenArn = '';
      this.book.generations = [];
      this.book.shelf = [];
      this.book.shelfOpen = false;
      this.book.activeVariant = 'base';
      this.book.compareVariant = null;
      this.book.comparePanels = [];
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

    /** Select an image for a specific page in the editor.
     *  Set _skipUndo = true when calling from batch operations that manage their own undo.
     */
    bookSelectImage(pageId, model, seed, img, _skipUndo = false) {
      if (!_skipUndo) this.bookPushUndo();
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

    /** Rate an image in editor mode, with Smart Suggest trigger for ★ */
    bookEditorRate(img, score) {
      if (!img) return;
      this.quickRate(img, score);
      // If star rating in editor mode, trigger Smart Suggest
      if (score === 5 && this.book.editorMode) {
        const model = img._model || this.book.selectedModel;
        this.bookCheckSuggestion(model);
      }
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

    /** Check if a page has regen candidates (R1, R2, etc.) */
    bookPageHasRegen(page) {
      if (!page || !page.models) return false;
      return page.models.some(m => m._generation && m._generation !== 'R0');
    },

    /** Get the thumbnail for a timeline slot (selected image or first available) */
    bookTimelineThumb(page) {
      const sel = this.book.selections[page.id];
      if (sel && sel.thumb_url) return sel.thumb_url;
      // Fallback: try selected model first, then first model
      const selModel = page.models.find(m => m.model === this.book.selectedModel);
      const selectedSeedImg = selModel?.images.find(i => i._seed === this.book.selectedSeed);
      if (selectedSeedImg?.thumb_url) return selectedSeedImg.thumb_url;
      if (selModel?.images[0]?.thumb_url) return selModel.images[0].thumb_url;
      return page.models[0]?.images[0]?.thumb_url || '';
    },

    /** Auto-select: for each page, pick the highest-rated image (or first) */
    bookAutoSelect() {
      this.bookPushUndo();
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
          this.bookSelectImage(page.id, bestModel, bestImg._seed || '', bestImg, true);
        }
      }
      this.bookSaveSelections();
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
          // Migrate R2→R1 references (from old naming)
          const sel = stored[bookKey];
          const migrated = {};
          for (const [k, v] of Object.entries(sel)) {
            const newKey = k.replace('_R2_', '_R1_');
            const newVal = { ...v };
            if (newVal.full_url) newVal.full_url = newVal.full_url.replace('_R2_', '_R1_');
            if (newVal.thumb_url) newVal.thumb_url = newVal.thumb_url.replace('_R2_', '_R1_');
            if (newVal.name) newVal.name = newVal.name.replace('_R2_', '_R1_');
            migrated[newKey] = newVal;
          }
          this.book.selections = migrated;
          // Save migrated version
          stored[bookKey] = migrated;
          localStorage.setItem('book_selections', JSON.stringify(stored));
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
    // Persistent Save / Load (S3 via API)
    // ==========================================

    /** Save full editor state to S3 */
    async bookSaveState() {
      const bookId = this.book.currentBook?.id;
      if (!bookId) return;
      this.book.saveStatus = 'saving';
      try {
        const state = {
          selections: this.book.selections,
          pageOrder: this.book.pages.map(p => p.id),
          shelf: (this.book.shelf || []).map(p => ({
            id: p.id, prompt_id: p.prompt_id, scene: p.scene, summary: p.summary,
            models: p.models,
          })),
          regenFlags: this.book.regenFlags || {},
          activeVariant: this.book.activeVariant || 'base',
        };
        const result = await GalleryAPI.saveBookState(bookId, state);
        this.book.saveStatus = 'saved';
        this.book.lastSavedAt = result.savedAt || '';
        // Auto-clear status after 3 seconds
        setTimeout(() => { if (this.book.saveStatus === 'saved') this.book.saveStatus = ''; }, 3000);
      } catch (e) {
        console.error('Failed to save book state:', e);
        this.book.saveStatus = 'error';
        setTimeout(() => { if (this.book.saveStatus === 'error') this.book.saveStatus = ''; }, 5000);
      }
    },

    /** Load editor state from S3 (called during openBook) */
    async bookLoadState() {
      const bookId = this.book.currentBook?.id;
      if (!bookId) return false;
      try {
        const state = await GalleryAPI.loadBookState(bookId);
        if (!state || !state.bookId) return false;

        // Restore selections
        if (state.selections) {
          this.book.selections = state.selections;
        }

        // Restore page order
        if (state.pageOrder && state.pageOrder.length > 0) {
          const pageMap = {};
          for (const p of this.book.pages) pageMap[p.id] = p;
          const orderedPages = state.pageOrder.map(id => pageMap[id]).filter(Boolean);
          // Pages loaded from server but not in saved order go to the end
          const orderedSet = new Set(state.pageOrder);
          for (const p of this.book.pages) {
            if (!orderedSet.has(p.id)) orderedPages.push(p);
          }
          this.book.pages = orderedPages;
        }

        // Restore shelf
        if (state.shelf && state.shelf.length > 0) {
          this.book.shelf = state.shelf;
        }

        // Restore regen flags
        if (state.regenFlags) {
          this.book.regenFlags = state.regenFlags;
        }

        // Restore active variant
        if (state.activeVariant) {
          this.book.activeVariant = state.activeVariant;
        }

        this.book.lastSavedAt = state.savedAt || '';
        console.log('Loaded book state from S3 for', bookId);
        return true;
      } catch (e) {
        // 404 = no saved state, not an error
        console.log('No saved state on S3 for', bookId);
        return false;
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
      event.dataTransfer.effectAllowed = 'all';

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
      event.dataTransfer.effectAllowed = 'all';
    },

    /** Handle drop on a timeline slot (swap/select only; inserts go through insert zones) */
    bookHandleTimelineDrop(event, targetIdx) {
      event.preventDefault();
      const el = event.currentTarget;
      el.classList.remove('drag-over');

      let data;
      try {
        data = JSON.parse(event.dataTransfer.getData('text/plain'));
      } catch { return; }

      if (data.type === 'candidate') {
        // SWAP: select image for the target page
        const img = { full_url: data.full_url, thumb_url: data.thumb_url, name: data.name };
        const targetPage = this.book.pages[targetIdx];
        if (!targetPage) return;
        this.bookSelectImage(targetPage.id, data.model, data.seed, img);
        this.book.currentPage = targetIdx;
      } else if (data.type === 'timeline') {
        // Timeline slot dropped on another slot -> reorder
        const fromIdx = data.fromIdx;
        if (fromIdx === targetIdx) return;
        this.bookHandleTimelineReorder(fromIdx, targetIdx);
      } else if (data.type === 'shelf') {
        // Shelf item dropped on timeline slot -> insert at position
        const shelfIdx = data.shelfIdx;
        if (shelfIdx == null) return;
        const shelf = [...this.book.shelf];
        if (shelfIdx < 0 || shelfIdx >= shelf.length) return;
        const [item] = shelf.splice(shelfIdx, 1);
        this.book.shelf = shelf;
        this.bookSaveShelf();
        const pages = [...this.book.pages];
        pages.splice(targetIdx, 0, item);
        this.book.pages = pages;
        this.book.currentPage = targetIdx;
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

    /** Insert page from fromIdx at toIdx position (shift, not swap) */
    bookHandleTimelineReorder(fromIdx, toIdx) {
      this.bookPushUndo();
      if (fromIdx === toIdx) return;
      const pages = [...this.book.pages];
      const [moved] = pages.splice(fromIdx, 1);
      // Adjust target index after removal
      const adjustedIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
      pages.splice(adjustedIdx, 0, moved);
      this.book.pages = pages;
      this.book.currentPage = adjustedIdx;
    },

    /** Handle drop on a dedicated insert zone between timeline slots */
    bookHandleInsertDrop(event, insertIdx) {
      event.preventDefault();
      event.currentTarget.classList.remove('active');
      let data;
      try { data = JSON.parse(event.dataTransfer.getData('text/plain')); } catch { return; }

      if (data.type === 'candidate') {
        this.bookPushUndo();
        const sourcePage = this.book.pages.find(p => p.id === data.pageId);
        if (!sourcePage) return;
        const newPage = { ...sourcePage, id: sourcePage.id + '_ins_' + Date.now(), _insertedFrom: data.pageId };
        const pages = [...this.book.pages];
        pages.splice(insertIdx, 0, newPage);
        this.book.pages = pages;
        this.bookSelectImage(newPage.id, data.model, data.seed, {
          full_url: data.full_url, thumb_url: data.thumb_url, name: data.name
        });
        this.book.currentPage = insertIdx;
      } else if (data.type === 'timeline') {
        this.bookHandleTimelineReorder(data.fromIdx, insertIdx);
      } else if (data.type === 'shelf') {
        const shelfIdx = data.shelfIdx;
        if (shelfIdx == null) return;
        this.bookPushUndo();
        const shelf = [...this.book.shelf];
        if (shelfIdx < 0 || shelfIdx >= shelf.length) return;
        const [item] = shelf.splice(shelfIdx, 1);
        this.book.shelf = shelf;
        this.bookSaveShelf();
        const pages = [...this.book.pages];
        pages.splice(insertIdx, 0, item);
        this.book.pages = pages;
        this.book.currentPage = insertIdx;
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

    /** Drag over handler for timeline slots - swap only (insert via dedicated zones) */
    bookTimelineDragOver(event, slotIdx) {
      event.preventDefault();
    },

    /** Get a short display name for a page ID */
    bookShortPageId(pageId) {
      // "0216a_R1_S08f_climax" -> "R1:S08f"
      // "0216a_S00_cover" -> "S00"
      const gen = this.bookGetGeneration(pageId);
      const sceneMatch = pageId.match(/(S\d+[a-z]?)/i);
      const scene = sceneMatch ? sceneMatch[1] : pageId.slice(-6);
      if (gen !== 'R0') {
        return `${gen}:${scene}`;
      }
      return scene;
    },

    // ==========================================
    // Page Remove & Shelf (Feature 6)
    // ==========================================

    /** Get the rating icon for a page's current selection or first image */
    bookTimelineRatingIcon(page) {
      // Check selected image first
      const sel = this.book.selections[page.id];
      if (sel && sel._ratingImg) {
        const r = this.getImageRating(sel._ratingImg);
        if (r === 5) return '\u2605'; // star
        if (r === -1) return '\uD83D\uDC4E'; // thumbs down
      }
      // Check first image of first model
      const firstModel = page.models[0];
      if (!firstModel) return '';
      for (const img of firstModel.images) {
        const r = this.getImageRating(img);
        if (r === 5) return '\u2605';
        if (r === -1) return '\uD83D\uDC4E';
      }
      return '';
    },

    /** Get the rating class for timeline overlay */
    bookTimelineRatingClass(page) {
      const firstModel = page.models[0];
      if (!firstModel) return '';
      for (const img of firstModel.images) {
        const r = this.getImageRating(img);
        if (r === 5) return 'rating-star';
        if (r === -1) return 'rating-bad';
      }
      return '';
    },

    /** Remove a page from the timeline and add to shelf */
    bookRemovePage(idx) {
      this.bookPushUndo();
      const pages = [...this.book.pages];
      if (idx < 0 || idx >= pages.length) return;
      const [removed] = pages.splice(idx, 1);
      this.book.pages = pages;
      // Add to shelf
      if (!this.book.shelf) this.book.shelf = [];
      this.book.shelf = [...this.book.shelf, removed];
      this.bookSaveShelf();
      if (this.book.currentPage >= pages.length) {
        this.book.currentPage = Math.max(0, pages.length - 1);
      }
    },

    /** Start dragging a shelf item */
    bookDragStartShelf(event, idx) {
      const item = this.book.shelf[idx];
      if (!item) return;
      const data = {
        type: 'shelf',
        shelfIdx: idx,
      };
      event.dataTransfer.setData('text/plain', JSON.stringify(data));
      event.dataTransfer.effectAllowed = 'move';
    },

    /** Restore a shelf item back to the end of the timeline */
    bookRestoreFromShelf(idx) {
      this.bookPushUndo();
      const shelf = [...this.book.shelf];
      if (idx < 0 || idx >= shelf.length) return;
      const [item] = shelf.splice(idx, 1);
      this.book.shelf = shelf;
      this.bookSaveShelf();
      this.book.pages = [...this.book.pages, item];
    },

    /** Permanently remove a shelf item */
    bookRemoveFromShelf(idx) {
      const shelf = [...this.book.shelf];
      if (idx < 0 || idx >= shelf.length) return;
      shelf.splice(idx, 1);
      this.book.shelf = shelf;
      this.bookSaveShelf();
    },

    /** Handle drop on the Shelf area (move page from timeline to shelf) */
    bookHandleShelfDrop(event) {
      event.preventDefault();
      event.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
      let data;
      try { data = JSON.parse(event.dataTransfer.getData('text/plain')); } catch { return; }
      if (data.type === 'timeline') {
        this.bookRemovePage(data.fromIdx);
      }
    },

    /** Save shelf to localStorage */
    bookSaveShelf() {
      try {
        const stored = JSON.parse(localStorage.getItem('book_shelf') || '{}');
        const bookKey = this.book.currentBook?.id;
        if (bookKey) {
          // Store minimal data for shelf items (page id, scene, summary, first thumb)
          stored[bookKey] = (this.book.shelf || []).map(p => ({
            id: p.id, prompt_id: p.prompt_id, scene: p.scene, summary: p.summary,
            models: p.models,
          }));
          localStorage.setItem('book_shelf', JSON.stringify(stored));
        }
      } catch (e) {
        console.error('Failed to save shelf:', e);
      }
    },

    /** Load shelf from localStorage */
    bookLoadShelf() {
      try {
        const stored = JSON.parse(localStorage.getItem('book_shelf') || '{}');
        const bookKey = this.book.currentBook?.id;
        if (bookKey && stored[bookKey]) {
          this.book.shelf = stored[bookKey];
        } else {
          this.book.shelf = [];
        }
      } catch {
        this.book.shelf = [];
      }
      this.book.shelfOpen = false;
    },

    /** Get thumbnail for a shelf item */
    bookShelfThumb(item) {
      const firstModel = item.models?.[0];
      return firstModel?.images?.[0]?.thumb_url || '';
    },

    // ==========================================
    // Generation Versioning (Feature 5)
    // ==========================================

    /** Extract the generation from a pageId/prompt_id.
     *  "0216a_R1_S08f_climax" -> "R1"
     *  "0216a_S08f_climax"    -> "R0" (no Rn prefix = original)
     */
    bookGetGeneration(pageId) {
      if (!pageId) return 'R0';
      const match = pageId.match(/_R(\d+)_/);
      // No Rn_ prefix = R0 (original), R1/R2/R3 etc. = regen version
      return match ? `R${match[1]}` : 'R0';
    },

    /** Extract the scene part from a pageId, stripping bookId and generation prefix.
     *  "0216a_R1_S08f_climax" -> "S08f_climax"
     *  "0216a_S08f_climax" -> "S08f_climax"
     */
    bookGetSceneId(pageId) {
      if (!pageId) return '';
      // Remove bookId prefix (e.g. "0216a_")
      let rest = pageId.replace(/^\d{4}[a-z]_/, '');
      // Remove generation prefix (e.g. "R1_")
      rest = rest.replace(/^R\d+_/, '');
      return rest;
    },

    /** Scan all pages and build the generations list. Called after openBook() loads pages. */
    bookDetectGenerations() {
      const genSet = new Set();
      for (const page of this.book.pages) {
        const gen = this.bookGetGeneration(page.id);
        genSet.add(gen);
      }
      // Sort: 'R0' first, then R1, R2, R3...
      const gens = [...genSet].sort((a, b) => {
        if (a === 'R0') return -1;
        if (b === 'R0') return 1;
        const na = parseInt(a.replace('R', ''));
        const nb = parseInt(b.replace('R', ''));
        return na - nb;
      });
      this.book.generations = gens;
    },

    /** Get candidates filtered by variant and generation.
     *  @param {string} [variantOverride] - override active variant (for compare panel)
     *  Filters by variant first, then groups by model with per-model gen tabs.
     */
    bookFilteredCandidatesByModel(variantOverride) {
      const page = this.bookCurrentPage();
      if (!page) return [];

      const variant = variantOverride || this.book.activeVariant || 'base';

      // Filter models to the selected variant
      const filtered = page.models.filter(m => (m._variant || 'base') === variant);

      // Group by model name, each model has generations as sub-groups
      const modelMap = {};
      for (const modelData of filtered) {
        const name = modelData.model;
        const gen = modelData._generation || 'R0';
        if (!modelMap[name]) {
          modelMap[name] = { model: name, generations: {}, activeGen: null };
        }
        modelMap[name].generations[gen] = modelData;
      }

      // Set activeGen per model: default to latest generation (R2 > R1 > original)
      if (!this.book._modelGenPrefs) this.book._modelGenPrefs = {};
      for (const [name, group] of Object.entries(modelMap)) {
        const gens = Object.keys(group.generations).sort((a, b) => {
          const na = parseInt(a.replace('R', '')) || 0;
          const nb = parseInt(b.replace('R', '')) || 0;
          return na - nb;
        });
        const pref = this.book._modelGenPrefs[name];
        const latest = gens[gens.length - 1] || 'R0';
        group.activeGen = (pref && gens.includes(pref)) ? pref : latest;
        group.availableGens = gens;
      }

      return Object.values(modelMap).map(group => {
        const activeData = group.generations[group.activeGen];
        if (!activeData) return null;
        return {
          model: group.model,
          activeGen: group.activeGen,
          availableGens: group.availableGens,
          images: activeData.images.map(img => ({
            model: group.model,
            seed: img._seed || '?',
            img,
            detail: activeData.detail,
          })),
        };
      }).filter(g => g && g.images.length > 0);
    },

    // ==========================================
    // Undo / Redo
    // ==========================================

    /** Save current state to undo stack */
    bookPushUndo() {
      const snapshot = {
        pages: JSON.parse(JSON.stringify(this.book.pages.map(p => p.id))),
        selections: JSON.parse(JSON.stringify(this.book.selections)),
        shelf: JSON.parse(JSON.stringify(this.book.shelf || [])),
        currentPage: this.book.currentPage,
      };
      this.book._undoStack = [...this.book._undoStack, snapshot];
      if (this.book._undoStack.length > 50) this.book._undoStack.shift(); // limit
      this.book._redoStack = []; // clear redo on new action
    },

    /** Restore state from a snapshot */
    _bookRestoreSnapshot(snapshot) {
      if (!snapshot) return;
      // Restore page order (re-find page objects by id)
      const pageMap = {};
      for (const p of this.book.pages) pageMap[p.id] = p;
      for (const p of (this.book.shelf || [])) pageMap[p.id] = p;
      const restoredPages = snapshot.pages.map(id => pageMap[id]).filter(Boolean);
      // Pages not in restored list go to shelf
      const restoredSet = new Set(snapshot.pages);
      const restoredShelf = snapshot.shelf.map(id => pageMap[id]).filter(Boolean);

      this.book.pages = restoredPages;
      this.book.selections = snapshot.selections;
      this.book.shelf = restoredShelf;
      this.book.currentPage = Math.min(snapshot.currentPage, restoredPages.length - 1);
      this.bookSaveSelections();
      this.bookSaveShelf();
    },

    bookUndo() {
      if (this.book._undoStack.length === 0) return;
      // Save current state to redo
      const current = {
        pages: this.book.pages.map(p => p.id),
        selections: JSON.parse(JSON.stringify(this.book.selections)),
        shelf: (this.book.shelf || []).map(p => p.id),
        currentPage: this.book.currentPage,
      };
      this.book._redoStack = [...this.book._redoStack, current];
      // Restore previous state
      const prev = this.book._undoStack.pop();
      this.book._undoStack = [...this.book._undoStack];
      this._bookRestoreSnapshot(prev);
    },

    bookRedo() {
      if (this.book._redoStack.length === 0) return;
      // Save current to undo
      const current = {
        pages: this.book.pages.map(p => p.id),
        selections: JSON.parse(JSON.stringify(this.book.selections)),
        shelf: (this.book.shelf || []).map(p => p.id),
        currentPage: this.book.currentPage,
      };
      this.book._undoStack = [...this.book._undoStack, current];
      // Restore next state
      const next = this.book._redoStack.pop();
      this.book._redoStack = [...this.book._redoStack];
      this._bookRestoreSnapshot(next);
    },

    /** Switch the active generation for a specific model in candidates */
    bookSwitchModelGen(model, gen) {
      if (!this.book._modelGenPrefs) this.book._modelGenPrefs = {};
      this.book._modelGenPrefs = { ...this.book._modelGenPrefs, [model]: gen };
    },

    // ==========================================
    // Variant UI (Feature 7)
    // ==========================================

    /** Switch the active variant tab */
    bookSwitchVariant(variant) {
      this.book.activeVariant = variant;
    },

    /** Add a compare panel (max 10) */
    bookAddComparePanel() {
      if (this.book.comparePanels.length >= 10) return;
      const page = this.bookCurrentPage();
      if (!page || !page.variants) return;
      // Pick first variant not already in use
      const used = new Set([this.book.activeVariant, ...this.book.comparePanels]);
      const next = page.variants.find(v => !used.has(v)) || page.variants[0];
      this.book.comparePanels = [...this.book.comparePanels, next];
      this.book.compareVariant = this.book.comparePanels[0]; // compat
    },

    /** Remove a compare panel by index */
    bookRemoveComparePanel(idx) {
      this.book.comparePanels = this.book.comparePanels.filter((_, i) => i !== idx);
      this.book.compareVariant = this.book.comparePanels[0] || null; // compat
    },

    /** Change variant for a specific compare panel */
    bookSetComparePanel(idx, variant) {
      const panels = [...this.book.comparePanels];
      panels[idx] = variant;
      this.book.comparePanels = panels;
    },

    /** Start compare mode: open one panel with first non-active variant */
    bookStartCompare() {
      const page = this.bookCurrentPage();
      if (!page || !page.variants || page.variants.length < 2) return;
      const other = page.variants.find(v => v !== this.book.activeVariant);
      if (other) {
        this.book.comparePanels = [other];
        this.book.compareVariant = other; // compat
      }
    },

    /** Close all compare panels */
    bookCloseCompare() {
      this.book.comparePanels = [];
      this.book.compareVariant = null;
    },

    // ==========================================
    // Batch Rate (Feature 1)
    // ==========================================

    /** Handle timeline slot click with optional Shift for multi-select */
    bookTimelineClick(event, idx) {
      if (event.shiftKey && this.book.editorMode) {
        // Toggle this page in the multi-selection
        const pos = this.book.selectedPages.indexOf(idx);
        if (pos >= 0) {
          this.book.selectedPages = this.book.selectedPages.filter(i => i !== idx);
        } else {
          this.book.selectedPages = [...this.book.selectedPages, idx];
        }
      } else {
        // Normal click: navigate to that page, clear multi-selection
        this.book.selectedPages = [];
        this.book.currentPage = idx;
      }
    },

    /** Apply a rating to the current preview image on all multi-selected pages */
    bookBatchRate(score) {
      this.bookPushUndo();
      if (this.book.selectedPages.length === 0) return;

      // Get the current preview image to identify which image to rate on other pages
      const previewImg = this.bookEditorPreviewImage();
      if (!previewImg) return;

      // For each selected page, find the matching model+seed image and rate it
      const model = previewImg.model || this.book.selectedModel;
      const seed = previewImg.seed || this.book.selectedSeed;

      for (const pageIdx of this.book.selectedPages) {
        const page = this.book.pages[pageIdx];
        if (!page) continue;

        // Find the image for this model on that page
        const modelData = page.models.find(m => m.model === model);
        if (!modelData) continue;

        // Find matching seed, or fall back to first image
        let targetImg = modelData.images.find(img => img._seed === seed);
        if (!targetImg) targetImg = modelData.images[0];
        if (!targetImg) continue;

        this.quickRate(targetImg, score);
      }

      // Clear multi-selection after batch rating
      this.book.selectedPages = [];
    },

    /** Clear multi-selection */
    bookClearMultiSelect() {
      this.book.selectedPages = [];
    },

    /** Check if a page index is multi-selected */
    bookIsMultiSelected(idx) {
      return this.book.selectedPages.includes(idx);
    },

    // ==========================================
    // Smart Suggest (Feature 2)
    // ==========================================

    /** Check if we should suggest a model after a star rating in editor mode */
    bookCheckSuggestion(model) {
      if (!this.book.editorMode || !model) return;

      // Count unselected pages
      const unselectedPages = this.book.pages.filter(p => !this.book.selections[p.id]);
      const count = unselectedPages.length;

      // Only suggest if more than 3 unselected pages
      if (count <= 3) {
        this.book.suggestion = null;
        return;
      }

      // Check how many unselected pages have this model available
      let availableCount = 0;
      for (const page of unselectedPages) {
        if (page.models.some(m => m.model === model)) {
          availableCount++;
        }
      }

      if (availableCount === 0) {
        this.book.suggestion = null;
        return;
      }

      const shortModel = this.displayModelName ? this.displayModelName(model) : model;
      this.book.suggestion = {
        model,
        count: availableCount,
        message: `★ on ${shortModel} — Apply to ${availableCount} unselected pages?`,
      };
    },

    /** Apply the suggested model to all unselected pages */
    bookApplySuggestion() {
      if (!this.book.suggestion) return;
      this.bookPushUndo();
      const model = this.book.suggestion.model;

      for (const page of this.book.pages) {
        // Skip pages that already have a selection
        if (this.book.selections[page.id]) continue;

        const modelData = page.models.find(m => m.model === model);
        if (!modelData || modelData.images.length === 0) continue;

        // Find the best image by AI score, then by any rating
        let bestImg = null;
        let bestScore = -Infinity;
        for (const img of modelData.images) {
          const aiScore = this.getAestheticScore(img) || 0;
          const rating = this.getImageRating(img) || 0;
          const score = rating * 100 + aiScore * 50;
          if (score > bestScore) {
            bestScore = score;
            bestImg = img;
          }
        }

        if (bestImg) {
          this.bookSelectImage(page.id, model, bestImg._seed || '', bestImg, true);
        }
      }
      this.bookSaveSelections();

      this.book.suggestion = null;
    },

    /** Dismiss the suggestion */
    bookDismissSuggestion() {
      this.book.suggestion = null;
    },

    // ==========================================
    // Before/After Regen (Feature 3)
    // ==========================================

    /** Start editing the prompt for the current page */
    bookStartEditPrompt() {
      const page = this.bookCurrentPage();
      if (!page) return;

      // Try to get the prompt from experiment metadata
      let prompt = '';
      if (page.models.length > 0) {
        const detail = page.models[0].detail;
        prompt = detail?.metadata?.prompt?.positive || '';
      }

      // Check if there is already a regen flag for this page
      if (this.book.regenFlags[page.id]) {
        prompt = this.book.regenFlags[page.id].newPrompt;
      }

      this.book.editPromptText = prompt;
      this.book.editingPrompt = true;
    },

    /** Save the edited prompt and flag the page for regeneration */
    bookSaveRegenFlag() {
      const page = this.bookCurrentPage();
      if (!page) return;

      // Get original prompt for reference
      let originalPrompt = '';
      if (page.models.length > 0) {
        const detail = page.models[0].detail;
        originalPrompt = detail?.metadata?.prompt?.positive || '';
      }

      this.book.regenFlags = {
        ...this.book.regenFlags,
        [page.id]: {
          newPrompt: this.book.editPromptText,
          originalPrompt,
          flaggedAt: new Date().toISOString(),
        },
      };

      // Persist to localStorage
      this._saveRegenFlags();
      this.book.editingPrompt = false;
    },

    /** Cancel prompt editing */
    bookCancelEditPrompt() {
      this.book.editingPrompt = false;
      this.book.editPromptText = '';
    },

    /** Remove a regen flag for the current page */
    bookRemoveRegenFlag() {
      const page = this.bookCurrentPage();
      if (!page) return;
      const newFlags = { ...this.book.regenFlags };
      delete newFlags[page.id];
      this.book.regenFlags = newFlags;
      this._saveRegenFlags();
    },

    /** Count of pages flagged for regeneration */
    bookRegenFlagCount() {
      return Object.keys(this.book.regenFlags).length;
    },

    /** Check if a page is flagged for regen */
    bookIsRegenFlagged(pageId) {
      return !!this.book.regenFlags[pageId];
    },

    /** Export regen list as JSON download */
    bookExportRegenList() {
      const flags = this.book.regenFlags;
      if (Object.keys(flags).length === 0) {
        alert('No pages flagged for regeneration.');
        return;
      }

      // Build export format compatible with generate-eval.py
      const regenList = [];
      for (const [pageId, flag] of Object.entries(flags)) {
        const page = this.book.pages.find(p => p.id === pageId);
        regenList.push({
          page_id: pageId,
          scene: page?.scene || pageId,
          summary: page?.summary || '',
          original_prompt: flag.originalPrompt,
          new_prompt: flag.newPrompt,
          flagged_at: flag.flaggedAt,
        });
      }

      const data = {
        book_id: this.book.currentBook?.id || 'unknown',
        book_theme: this.book.currentBook?.theme || '',
        flagged_pages: regenList.length,
        exported_at: new Date().toISOString(),
        pages: regenList,
      };

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const bookName = this.book.currentBook?.theme || 'book';
      a.download = `${bookName}_regen_list.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },

    /** Save regen flags to localStorage */
    _saveRegenFlags() {
      try {
        const stored = JSON.parse(localStorage.getItem('book_regen_flags') || '{}');
        const bookKey = this.book.currentBook?.id;
        if (bookKey) {
          stored[bookKey] = this.book.regenFlags;
          localStorage.setItem('book_regen_flags', JSON.stringify(stored));
        }
      } catch (e) {
        console.error('Failed to save regen flags:', e);
      }
    },

    /** Load regen flags from localStorage */
    _loadRegenFlags() {
      try {
        const stored = JSON.parse(localStorage.getItem('book_regen_flags') || '{}');
        const bookKey = this.book.currentBook?.id;
        if (bookKey && stored[bookKey]) {
          this.book.regenFlags = stored[bookKey];
        } else {
          this.book.regenFlags = {};
        }
      } catch {
        this.book.regenFlags = {};
      }
    },

    // ==========================================
    // Regeneration Workflow (Feature 4)
    // ==========================================

    /** Trigger regeneration from UI - collects flagged pages and calls API */
    async bookTriggerRegen() {
      const flags = this.book.regenFlags;
      const flaggedPageIds = Object.keys(flags);
      if (flaggedPageIds.length === 0) {
        alert('No pages flagged for regeneration.');
        return;
      }

      if (!confirm(`Regenerate ${flaggedPageIds.length} page(s)? This will start a batch job across all models.`)) {
        return;
      }

      // Build pages payload
      const pages = [];
      for (const [pageId, flag] of Object.entries(flags)) {
        const page = this.book.pages.find(p => p.id === pageId);
        // Determine genre and type from existing experiment metadata
        let genre = '';
        let type = 'sensitive';
        if (page && page.models.length > 0) {
          const detail = page.models[0].detail;
          genre = detail?.metadata?.genre || this.book.currentBook?.genre || '';
          type = detail?.metadata?.type || 'sensitive';
        }
        pages.push({
          pageId,
          prompt: flag.newPrompt,
          genre,
          type,
        });
      }

      const bookId = this.book.currentBook?.bookId || this.book.currentBook?.id || 'unknown';
      const originalSeeds = this._getBookOriginalSeeds();

      this.book.regenRunning = true;
      this.book.regenCompleted = false;
      this.book.regenStatus = 'Starting...';

      try {
        const result = await GalleryAPI.startRegeneration(bookId, pages, [], originalSeeds);
        this.book.regenArn = result.executionArn;
        this.book.regenStatus = `Running (${result.promptCount} prompts, ${result.models.length} models)`;

        // Start polling
        this.bookPollRegenStatus();
      } catch (e) {
        console.error('Regeneration failed to start:', e);
        this.book.regenRunning = false;
        this.book.regenStatus = '';
        alert('Failed to start regeneration: ' + e.message);
      }
    },

    /** Extract original seeds from experiment metadata (first page with seeds wins) */
    _getBookOriginalSeeds() {
      for (const page of (this.book.pages || [])) {
        for (const m of (page.models || [])) {
          const seeds = m.detail?.metadata?.seeds;
          if (Array.isArray(seeds) && seeds.length > 0) return seeds;
        }
      }
      return [42, 123, 456]; // fallback
    },

    /** Poll regeneration status until completed */
    async bookPollRegenStatus() {
      if (!this.book.regenArn) return;

      // Clear any existing timer
      if (this.book.regenPollTimer) {
        clearTimeout(this.book.regenPollTimer);
        this.book.regenPollTimer = null;
      }

      try {
        const result = await GalleryAPI.getRegenerationStatus(this.book.regenArn);
        const status = result.status;

        if (status === 'RUNNING') {
          this.book.regenStatus = 'Running...';
          // Poll again in 15 seconds
          this.book.regenPollTimer = setTimeout(() => this.bookPollRegenStatus(), 15000);
        } else if (status === 'SUCCEEDED') {
          this.book.regenRunning = false;
          this.book.regenCompleted = true;
          this.book.regenStatus = 'Completed';
        } else {
          // FAILED, ABORTED, or other
          this.book.regenRunning = false;
          this.book.regenCompleted = false;
          this.book.regenStatus = `${status}`;
          alert(`Regeneration ${status.toLowerCase()}.`);
        }
      } catch (e) {
        console.error('Failed to poll regen status:', e);
        // Retry in 30 seconds on error
        this.book.regenPollTimer = setTimeout(() => this.bookPollRegenStatus(), 30000);
      }
    },

    /** Stop polling (cleanup) */
    bookStopRegenPoll() {
      if (this.book.regenPollTimer) {
        clearTimeout(this.book.regenPollTimer);
        this.book.regenPollTimer = null;
      }
    },

    /** Reset regeneration state */
    bookResetRegenState() {
      this.bookStopRegenPoll();
      this.book.regenRunning = false;
      this.book.regenCompleted = false;
      this.book.regenStatus = '';
      this.book.regenArn = '';
    },

    // ==========================================
    // Export Methods
    // ==========================================

    /** Ensure jsPDF library is loaded */
    async _ensureJsPDF() {
      if (window.jspdf) return;
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load script'));
        document.head.appendChild(script);
      });
    },

    /** Ensure JSZip library is loaded */
    async _ensureJSZip() {
      if (window.JSZip) return;
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load script'));
        document.head.appendChild(script);
      });
    },

    /** Fetch an image and return as a data URL */
    async _fetchImageAsDataURL(url) {
      // Fetch image as blob, convert to object URL, draw on canvas
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${url}`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          URL.revokeObjectURL(objectUrl);
          resolve(canvas.toDataURL('image/jpeg', 0.92));
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Image load failed: ' + url));
        };
        img.src = objectUrl;
      });
    },

    /** Fetch an image and return as blob */
    async _fetchImageAsBlob(url) {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${url}`);
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

          // Add image full page, no background, no margins
          const format = dataUrl.includes('data:image/png') ? 'PNG' : 'JPEG';
          pdf.addImage(dataUrl, format, 0, 0, pageWidth, pageHeight);
        }

        this.book.exportProgress = 'Generating PDF...';
        const bookName = this.book.currentBook?.theme || 'book';
        pdf.save(`${bookName}.pdf`);

      } catch (e) {
        console.error('PDF export failed:', e);
        alert('PDF export failed: ' + (e?.message || e || 'Unknown error'));
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
        alert('ZIP export failed: ' + (e?.message || e || 'Unknown error'));
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
