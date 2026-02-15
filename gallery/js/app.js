document.addEventListener('alpine:init', () => {
  Alpine.data('gallery', () => ({
    // --- State ---
    route: 'experiments',
    routeParam: null,
    experiments: [],
    filteredExperiments: [],
    currentExperiment: null,
    productions: [],
    ratings: { _version: 2, images: {}, models: {} },
    selectedImages: [],
    loading: false,

    // Filters & sorting
    filters: { search: '', model: '', pipeline: '', ratingStatus: '', genre: '' },
    sortBy: 'date-desc', // date-desc, date-asc, model, rated
    availableModels: [],
    availablePipelines: [],
    availableGenres: [],

    // Pagination
    page: 1,
    pageSize: 40,

    // Auto-advance: move to next image after rating/favoriting in lightbox
    autoAdvance: true,

    // Blind mode
    blindMode: false,
    _blindMap: {},      // real model name -> masked name
    _blindOrder: [],    // shuffled order for grid display

    // Include mixins
    ...lightboxMixin(),
    ...compareMixin(),
    ...modelGridMixin(),
    ...dashboardMixin(),
    ...knowledgeBaseMixin(),

    // Debounced server rating save
    _ratingSaveTimer: null,

    // Rating axes configuration
    RATING_AXES: [
      { key: 'quality',  label: '画質',       short: '画質' },
      { key: 'fidelity', label: 'プロンプト忠実度', short: '忠実度' },
      { key: 'anatomy',  label: '人体破綻',    short: '人体' },
      { key: 'nsfw',     label: 'NSFW品質',   short: 'NSFW' },
      { key: 'overall',  label: '総合',       short: '総合' },
    ],

    // Save labels (presets)
    SAVE_LABEL_PRESETS: [
      'best-quality', 'face-reference', 'pose-reference',
      'style-reference', 'nsfw-quality', 'background', 'character-A',
    ],

    // --- Lifecycle ---
    async init() {
      // Load ratings from localStorage (with v2 migration)
      try {
        const stored = JSON.parse(localStorage.getItem('gallery_ratings') || '{}');
        this.ratings = this._migrateRatings(stored);
      } catch {
        this.ratings = { _version: 2, images: {}, models: {} };
      }

      // Load custom save labels
      try {
        const customLabels = JSON.parse(localStorage.getItem('gallery_custom_labels') || '[]');
        this._customLabels = customLabels;
      } catch {
        this._customLabels = [];
      }

      // Load blind mode and auto-advance state
      this.blindMode = localStorage.getItem('gallery_blind_mode') === 'true';
      const storedAutoAdv = localStorage.getItem('gallery_auto_advance');
      this.autoAdvance = storedAutoAdv === null ? true : storedAutoAdv === 'true';

      // Set up hash routing
      // Note: blind map is built after experiments load (needs model list)
      this.handleHashChange();
      window.addEventListener('hashchange', () => this.handleHashChange());

      // Load initial data
      await this.loadExperiments();

      // Rebuild blind map if blind mode was persisted (needs experiments loaded)
      if (this.blindMode) this._buildBlindMap();

      // Try to sync ratings from server
      try {
        const serverRatings = await GalleryAPI.getRatings();
        if (serverRatings && typeof serverRatings === 'object') {
          const migrated = this._migrateRatings(serverRatings);
          this.ratings = this._mergeRatings(this.ratings, migrated);
          localStorage.setItem('gallery_ratings', JSON.stringify(this.ratings));
        }
      } catch {
        // Server unavailable - use localStorage only
      }
    },

    // --- Ratings v2 Migration ---
    _migrateRatings(data) {
      if (!data || typeof data !== 'object') {
        return { _version: 2, images: {}, models: {} };
      }
      // Already v2
      if (data._version >= 2) return data;

      // Migrate v1: flat {url: number} -> v2
      const images = {};
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'number') {
          images[key] = {
            scores: { overall: val },
            comment: '',
            updated_at: new Date().toISOString(),
          };
        }
      }
      return { _version: 2, images, models: {} };
    },

    _mergeRatings(local, remote) {
      const merged = {
        _version: 2,
        images: { ...remote.images },
        models: { ...remote.models },
      };
      // Local wins if updated_at is newer
      for (const [key, localEntry] of Object.entries(local.images || {})) {
        const remoteEntry = merged.images[key];
        if (!remoteEntry || (localEntry.updated_at > (remoteEntry.updated_at || ''))) {
          merged.images[key] = localEntry;
        }
      }
      for (const [key, localEntry] of Object.entries(local.models || {})) {
        const remoteEntry = merged.models[key];
        if (!remoteEntry || (localEntry.updated_at > (remoteEntry.updated_at || ''))) {
          merged.models[key] = localEntry;
        }
      }
      return merged;
    },

    // --- Router ---
    handleHashChange() {
      const { route, param } = parseHash();
      this.route = route;
      this.routeParam = param;

      if (route === 'experiment' && param) {
        this.openExperiment(param);
      } else if (route === 'productions') {
        this.loadProductions();
      } else if (route === 'production' && param) {
        this.openProduction(param);
      } else if (route === 'compare') {
        if (this.compareLeft) this.loadCompareExperiment('left');
        if (this.compareRight) this.loadCompareExperiment('right');
      } else if (route === 'model-grid') {
        this.initModelGrid();
      } else if (route === 'dashboard') {
        this.initDashboard();
      } else if (route === 'knowledge-base') {
        this.loadExperiments().then(() => this.initKnowledgeBase());
      }
    },

    navigate(route, param) {
      window.location.hash = param ? `/${route}/${param}` : `/${route}`;
    },

    // --- Data Loading ---
    async loadExperiments() {
      if (this.experiments.length > 0) return;
      this.loading = true;
      try {
        const data = await GalleryAPI.getExperiments();
        this.experiments = Array.isArray(data) ? data : (data.experiments || []);
        this._buildFilterOptions();
        this.filterExperiments();
      } catch (e) {
        console.error('Failed to load experiments:', e);
        this.experiments = [];
        this.filteredExperiments = [];
      } finally {
        this.loading = false;
      }
    },

    async openExperiment(id) {
      this.loading = true;
      this.selectedImages = [];
      try {
        const data = await GalleryAPI.getExperiment(id);
        this.currentExperiment = data;
        // Auto-infer via Bedrock if no genre set (checks cache + persisted tags internally)
        this._inferGenreAsync(data);
        if (this.route !== 'experiment') {
          this.navigate('experiment', id);
          return;
        }
      } catch (e) {
        console.error('Failed to load experiment:', e);
        this.currentExperiment = null;
      } finally {
        this.loading = false;
      }
    },

    async loadProductions() {
      this.loading = true;
      try {
        const data = await GalleryAPI.getProductions();
        this.productions = Array.isArray(data) ? data : (data.productions || []);
      } catch (e) {
        console.error('Failed to load productions:', e);
        this.productions = [];
      } finally {
        this.loading = false;
      }
    },

    async openProduction(id) {
      this.loading = true;
      try {
        const data = await GalleryAPI.getProduction(id);
        this.currentProduction = data;
      } catch (e) {
        console.error('Failed to load production:', e);
      } finally {
        this.loading = false;
      }
    },

    // --- Filtering ---
    _buildFilterOptions() {
      const models = new Set();
      const pipelines = new Set();
      const genres = new Set();
      for (const exp of this.experiments) {
        if (exp.model) models.add(exp.model);
        if (exp.pipeline) pipelines.add(exp.pipeline);
        const g = this.getExpGenre(exp);
        if (g) genres.add(g);
      }
      this.availableModels = [...models].sort();
      this.availablePipelines = [...pipelines].sort();
      this.availableGenres = [...genres].sort();
    },

    filterExperiments() {
      let result = this.experiments;
      const search = this.filters.search.toLowerCase().trim();

      if (search) {
        result = result.filter((exp) => {
          const text = [exp.prompt_summary, exp.id, exp.model, exp.pipeline]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return text.includes(search);
        });
      }

      if (this.filters.model) {
        result = result.filter((exp) => exp.model === this.filters.model);
      }

      if (this.filters.pipeline) {
        result = result.filter((exp) => exp.pipeline === this.filters.pipeline);
      }

      if (this.filters.genre) {
        result = result.filter((exp) => this.getExpGenre(exp) === this.filters.genre);
      }

      // Rating status filter
      if (this.filters.ratingStatus === 'unrated') {
        result = result.filter((exp) => this._getExpRatedCount(exp) === 0);
      } else if (this.filters.ratingStatus === 'partial') {
        result = result.filter((exp) => {
          const rated = this._getExpRatedCount(exp);
          return rated > 0 && rated < (exp.image_count || 0);
        });
      } else if (this.filters.ratingStatus === 'rated') {
        result = result.filter((exp) => {
          const rated = this._getExpRatedCount(exp);
          return rated > 0 && rated >= (exp.image_count || 0);
        });
      } else if (this.filters.ratingStatus === 'favorited') {
        result = result.filter((exp) => this._getExpFavCount(exp) > 0);
      }

      // Sort
      if (this.sortBy === 'date-asc') {
        result.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      } else if (this.sortBy === 'model') {
        result.sort((a, b) => (a.model || '').localeCompare(b.model || ''));
      } else if (this.sortBy === 'rated') {
        result.sort((a, b) => this._getExpRatedCount(b) - this._getExpRatedCount(a));
      } else {
        result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      }

      this.filteredExperiments = result;
      this.page = 1;
    },

    /** Cached rated/fav counts per experiment. Rebuilt on rating changes. */
    _expCountCache: null,

    _buildExpCountCache() {
      const cache = {};
      for (const [key, entry] of Object.entries(this.ratings.images || {})) {
        // Find matching experiment by checking if key contains exp.id
        for (const exp of this.experiments) {
          if (!exp.id || !key.includes(exp.id)) continue;
          if (!cache[exp.id]) cache[exp.id] = { rated: 0, fav: 0 };
          if (entry?.scores && Object.values(entry.scores).some(v => v > 0)) {
            cache[exp.id].rated++;
          }
          if (entry?.favorited) cache[exp.id].fav++;
          break; // one image belongs to one experiment
        }
      }
      this._expCountCache = cache;
    },

    _getExpRatedCount(exp) {
      if (!this._expCountCache) this._buildExpCountCache();
      return this._expCountCache[exp?.id]?.rated || 0;
    },

    _getExpFavCount(exp) {
      if (!this._expCountCache) this._buildExpCountCache();
      return this._expCountCache[exp?.id]?.fav || 0;
    },

    /** Get paginated slice of filteredExperiments */
    get paginatedExperiments() {
      const start = (this.page - 1) * this.pageSize;
      return this.filteredExperiments.slice(start, start + this.pageSize);
    },

    get totalPages() {
      return Math.ceil(this.filteredExperiments.length / this.pageSize);
    },

    // --- Ratings (v2 multi-axis) ---
    _ratingKey(img) {
      if (!img) return null;
      return img.full_url || img.thumb_url || img.name;
    },

    /** Get single-axis score (0 if unrated) */
    getImageScore(img, axis) {
      const key = this._ratingKey(img);
      if (!key) return 0;
      const entry = this.ratings.images?.[key];
      if (!entry) return 0;
      return entry.scores?.[axis] || 0;
    },

    /** Get overall score: explicit overall, or average of other axes */
    getImageRating(img) {
      const key = this._ratingKey(img);
      if (!key) return 0;
      const entry = this.ratings.images?.[key];
      if (!entry) return 0;
      if (entry.scores?.overall) return entry.scores.overall;
      // Average of non-zero axes
      const vals = Object.values(entry.scores || {}).filter(v => v > 0);
      return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : 0;
    },

    /** Get average score across all axes for display */
    getImageAvgScore(img) {
      const key = this._ratingKey(img);
      if (!key) return 0;
      const entry = this.ratings.images?.[key];
      if (!entry?.scores) return 0;
      const vals = Object.values(entry.scores).filter(v => v > 0);
      return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : 0;
    },

    /** Get comment for an image */
    getImageComment(img) {
      const key = this._ratingKey(img);
      if (!key) return '';
      return this.ratings.images?.[key]?.comment || '';
    },

    /** Set score for a specific axis */
    setImageScore(img, axis, score) {
      const key = this._ratingKey(img);
      if (!key) return;

      // Flush any pending comment before potential auto-advance (prevents data loss)
      if (this.evalPanel._commentTimer) {
        clearTimeout(this.evalPanel._commentTimer);
        this.evalPanel._commentTimer = null;
        if (this.lightbox.currentImage && this.evalPanel.commentDraft !== this.getImageComment(this.lightbox.currentImage)) {
          this.setImageComment(this.lightbox.currentImage, this.evalPanel.commentDraft);
        }
      }

      const existing = this.ratings.images[key] || { scores: {}, comment: '' };
      const newScores = { ...existing.scores };
      // Toggle off if clicking the same score
      if (newScores[axis] === score) {
        delete newScores[axis];
      } else {
        newScores[axis] = score;
      }
      this.ratings.images = {
        ...this.ratings.images,
        [key]: { ...existing, scores: newScores, updated_at: new Date().toISOString() },
      };

      this._persistRatings();

      // Auto-advance in lightbox after scoring (skip if user is typing a comment)
      if (this.autoAdvance && this.lightbox.open) {
        const active = document.activeElement;
        if (!active || !active.matches('textarea, input[type="text"]')) {
          setTimeout(() => this.lightboxNext(), 300);
        }
      }
    },

    /** Legacy: set single overall rating (for grid overlay compat) */
    setImageRating(img, rating) {
      this.setImageScore(img, 'overall', rating);
    },

    /** Set comment for an image */
    setImageComment(img, comment) {
      const key = this._ratingKey(img);
      if (!key) return;

      const existing = this.ratings.images[key] || { scores: {}, comment: '' };
      this.ratings.images = {
        ...this.ratings.images,
        [key]: { ...existing, comment, updated_at: new Date().toISOString() },
      };
      this._persistRatings();
    },

    // --- Experiment tags (stored in ratings for persistence) ---
    getExpTags(expId) {
      return this.ratings.models?.['_exp_tags']?.[expId] || {};
    },

    setExpTag(expId, key, value) {
      if (!this.ratings.models['_exp_tags']) {
        this.ratings.models['_exp_tags'] = {};
      }
      if (!this.ratings.models['_exp_tags'][expId]) {
        this.ratings.models['_exp_tags'][expId] = {};
      }
      this.ratings.models['_exp_tags'][expId][key] = value;
      this._persistRatings();

      // Also update the experiment in memory for immediate filter effect
      const exp = this.experiments.find(e => e.id === expId);
      if (exp && key === 'genre') {
        exp._userGenre = value;
        this._buildFilterOptions();
      }
    },

    /** Get effective genre for an experiment (user override > metadata > auto-inferred) */
    getExpGenre(exp) {
      if (!exp) return '';
      const tags = this.getExpTags(exp.id);
      const raw = tags.genre || exp._userGenre || exp.genre || this._inferGenre(exp);
      return raw ? raw.toLowerCase() : '';
    },

    /** Genre inference cache + Bedrock LLM auto-inference */
    _inferGenreCache: {},
    _inferPending: {},  // tracks in-flight Bedrock calls

    _inferGenre(exp) {
      if (!exp?.id) return '';
      if (this._inferGenreCache[exp.id]) return this._inferGenreCache[exp.id];

      // Quick fallback from prompt_summary while async inference runs
      const fallback = (exp.prompt_summary || '').split(/[-_]/)[0];
      return fallback;
    },

    /** Call Bedrock Haiku to infer genre (async, updates cache + persists) */
    async _inferGenreAsync(exp) {
      if (!exp?.id) return;
      // Already cached or in-flight
      const tags = this.getExpTags(exp.id);
      if (tags.genre || tags._llmInferred) return;
      if (this._inferPending[exp.id]) return;

      const promptText = exp.metadata?.prompt?.positive || '';
      const summary = exp.prompt_summary || '';
      if (!promptText && !summary) return;

      this._inferPending[exp.id] = true;
      try {
        const result = await GalleryAPI.inferGenre(promptText, summary);
        if (result?.genre_en) {
          // Persist as user tag (so it's reused across sessions)
          this.setExpTag(exp.id, 'genre', result.genre_en);
          this.setExpTag(exp.id, '_llmInferred', true);
          if (result.tags) this.setExpTag(exp.id, 'tags', result.tags);
          if (result.nsfw_level) this.setExpTag(exp.id, 'nsfw_level', result.nsfw_level);
          if (result.scene) this.setExpTag(exp.id, 'scene', result.scene);
          if (result.genre) this.setExpTag(exp.id, 'genre_ja', result.genre);
          // Update cache for immediate display
          this._inferGenreCache[exp.id] = result.genre_en;
          this._buildFilterOptions();
        }
      } catch (e) {
        console.warn('Genre inference failed:', e);
      }
      delete this._inferPending[exp.id];
    },

    /** Get model-level data */
    getModelData(modelName) {
      return this.ratings.models?.[modelName] || { comment: '', verdict: '', updated_at: '' };
    },

    /** Set model comment and/or verdict */
    setModelData(modelName, { comment, verdict }) {
      if (!this.ratings.models[modelName]) {
        this.ratings.models[modelName] = { comment: '', verdict: '', updated_at: '' };
      }
      const entry = this.ratings.models[modelName];
      if (comment !== undefined) entry.comment = comment;
      if (verdict !== undefined) entry.verdict = verdict;
      entry.updated_at = new Date().toISOString();
      this._persistRatings();
    },

    /** Persist ratings to localStorage + debounced server sync */
    _persistRatings() {
      this._expCountCache = null; // invalidate cache
      if (this._invalidateKBCache) this._invalidateKBCache(); // invalidate KB cache
      localStorage.setItem('gallery_ratings', JSON.stringify(this.ratings));

      clearTimeout(this._ratingSaveTimer);
      this._ratingSaveTimer = setTimeout(() => {
        GalleryAPI.saveRatings(this.ratings).catch(() => {
          // Silent fail - localStorage is the source of truth
        });
      }, 2000);
    },

    // --- Blind Mode ---
    toggleBlindMode() {
      this.blindMode = !this.blindMode;
      localStorage.setItem('gallery_blind_mode', this.blindMode.toString());
      if (this.blindMode) {
        this._buildBlindMap();
      }
    },

    _buildBlindMap() {
      // Restore persisted mapping if model set hasn't changed
      const models = [...new Set(this.experiments.map(e => e.model).filter(Boolean))].sort();
      try {
        const stored = JSON.parse(localStorage.getItem('gallery_blind_map') || 'null');
        if (stored && stored._models) {
          const storedModels = [...stored._models].sort();
          if (JSON.stringify(storedModels) === JSON.stringify(models)) {
            this._blindMap = stored.map;
            this._blindOrder = stored._models;
            return;
          }
        }
      } catch {}

      // New shuffle needed (first time or model set changed)
      const shuffled = [...models];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      this._blindMap = {};
      shuffled.forEach((name, i) => {
        this._blindMap[name] = this._blindLabel(i);
      });
      this._blindOrder = shuffled;

      // Persist for consistency across reloads
      localStorage.setItem('gallery_blind_map', JSON.stringify({
        map: this._blindMap,
        _models: shuffled,
      }));
    },

    _blindLabel(index) {
      // A-Z, then AA, AB, etc.
      if (index < 26) return 'Model ' + String.fromCharCode(65 + index);
      const first = String.fromCharCode(65 + Math.floor(index / 26) - 1);
      const second = String.fromCharCode(65 + (index % 26));
      return 'Model ' + first + second;
    },

    displayModelName(realName) {
      if (!this.blindMode || !realName) return realName;
      return this._blindMap[realName] || realName;
    },

    revealBlindMode() {
      this.blindMode = false;
      localStorage.setItem('gallery_blind_mode', 'false');
      localStorage.removeItem('gallery_blind_map'); // clear so next blind session re-shuffles
    },

    // --- Selection ---
    isSelected(img) {
      return this.selectedImages.some(
        (s) => (s.full_url || s.name) === (img.full_url || img.name)
      );
    },

    toggleSelect(img) {
      if (this.isSelected(img)) {
        this.selectedImages = this.selectedImages.filter(
          (s) => (s.full_url || s.name) !== (img.full_url || img.name)
        );
      } else {
        this.selectedImages.push(img);
      }
    },

    async selectToProduction() {
      const productionId = prompt('Production ID:');
      if (!productionId) return;

      const experimentId = this.currentExperiment?.id;
      if (!experimentId) return;

      const imageNames = this.selectedImages.map((img) => img.name);

      try {
        await GalleryAPI.selectImages(experimentId, productionId, imageNames);
        this.selectedImages = [];
        alert('Images copied to production.');
      } catch (e) {
        console.error('Failed to select images:', e);
        alert('Failed to copy images. Please try again.');
      }
    },

    // --- Quick favorite from experiment card thumbnail ---
    _isExpFavorited(exp) {
      return this._getExpFavCount(exp) > 0;
    },

    async _quickFavExperiment(exp) {
      if (!exp?.id) return;
      try {
        const data = await GalleryAPI.getExperiment(exp.id);
        const images = data?.images || [];
        if (!images.length) return;
        // Open lightbox at first image with auto-advance ON for rapid scanning
        this.autoAdvance = true;
        localStorage.setItem('gallery_auto_advance', 'true');
        this.openLightbox(0, null, images, data);
      } catch (e) {
        console.error('Failed to open experiment for fav scan:', e);
      }
    },

    // --- Reload experiments (no full page refresh) ---
    async reloadExperiments() {
      this.experiments = [];
      this._expCountCache = null;
      await this.loadExperiments();
    },

    // --- Bulk delete filtered experiments ---
    async bulkDeleteFiltered() {
      const targets = this.filteredExperiments;
      if (!targets.length) return;
      if (!confirm(`Delete ${targets.length} experiments?\nThis cannot be undone.`)) return;

      let deleted = 0;
      for (const exp of [...targets]) {
        try {
          await GalleryAPI.deleteExperiment(exp.id);
          this.experiments = this.experiments.filter(e => e.id !== exp.id);
          deleted++;
        } catch (e) {
          console.error(`Failed to delete ${exp.id}:`, e);
        }
      }
      this._buildFilterOptions();
      this.filterExperiments();
      this._expCountCache = null;
      alert(`Deleted ${deleted} / ${targets.length} experiments.`);
    },

    // --- Delete experiment ---
    async deleteExperiment(expId) {
      if (!expId) return;
      if (!confirm(`Delete experiment?\n${expId}`)) return;
      try {
        await GalleryAPI.deleteExperiment(expId);
        this.experiments = this.experiments.filter(e => e.id !== expId);
        this._buildFilterOptions();
        this.filterExperiments();
        this._expCountCache = null;
        if (this.currentExperiment?.id === expId) {
          this.navigate('experiments');
        }
      } catch (e) {
        console.error('Delete failed:', e);
        alert('Delete failed.');
      }
    },

    // --- Navigation helpers ---
    goToUnrated() {
      const unrated = this.experiments.find(exp => this._getExpRatedCount(exp) === 0);
      if (unrated) {
        this.openExperiment(unrated.id);
      } else {
        // All rated — find partially rated
        const partial = this.experiments.find(exp => {
          const rated = this._getExpRatedCount(exp);
          return rated > 0 && rated < (exp.image_count || 0);
        });
        if (partial) {
          this.openExperiment(partial.id);
        } else {
          this.navigate('experiments');
        }
      }
    },

    // --- Utility: extract model name from experiment ---
    _extractModelFromExperiment(exp) {
      return exp?.model || exp?.metadata?.model?.checkpoint || exp?.id?.split('_')[1] || 'unknown';
    },
  }));
});
