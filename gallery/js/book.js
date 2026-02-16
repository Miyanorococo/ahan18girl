/**
 * Book view mixin for Alpine.js gallery component.
 * A "Book" = experiments from the same date + prompt prefix (= one batch job).
 * Browse pages in story order with model/seed switching.
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
    },

    /**
     * Initialize Book list. Groups experiments by date + prompt prefix = one book.
     */
    async initBookList() {
      this.book.loading = true;
      this.book.currentBook = null;
      this.book.pages = [];

      await this.loadExperiments();

      // Group experiments by date + prefix → books
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

        // Extract book ID: "0216a_S00_cover" → bookId="0216a", or legacy "S00_cover" → bookId="S"
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
      this.book.loading = false;
    },

    /** Back to book list */
    closeBook() {
      this.book.currentBook = null;
      this.book.pages = [];
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
  };
}
