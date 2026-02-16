/**
 * Book view mixin for Alpine.js gallery component.
 * Browse a story as pages in order, with model/seed switching per page.
 */
function bookMixin() {
  return {
    book: {
      pages: [],          // [{id, prompt_id, scene, models: [{model, images: [{...}]}]}]
      currentPage: 0,
      selectedModel: '',
      selectedSeed: '',
      allModels: [],
      allSeeds: [],
      loading: false,
      bookId: '',         // prefix like "S" for prod story
    },

    /**
     * Initialize Book view. Groups experiments by scene order.
     */
    async initBook(prefix) {
      this.book.loading = true;
      this.book.bookId = prefix || 'S';

      await this.loadExperiments();

      // Find all experiments matching the book prefix
      const bookExps = this.experiments.filter(e => {
        const pid = e.prompt_id || '';
        return pid.startsWith(this.book.bookId) && /^\d/.test(pid.slice(this.book.bookId.length));
      });

      if (!bookExps.length) {
        this.book.loading = false;
        return;
      }

      // Group by scene (prompt_id without model prefix)
      const sceneMap = {};
      const modelSet = new Set();
      const seedSet = new Set();

      for (const exp of bookExps) {
        const pid = exp.prompt_id || '';
        if (!sceneMap[pid]) {
          sceneMap[pid] = { models: {} };
        }
        const model = exp.model;
        modelSet.add(model);
        sceneMap[pid].models[model] = exp;
      }

      // Sort scenes by ID (S00, S01, S02, ...)
      const sortedScenes = Object.keys(sceneMap).sort((a, b) => {
        const na = a.replace(/[^0-9a-z]/gi, '');
        const nb = b.replace(/[^0-9a-z]/gi, '');
        return na.localeCompare(nb);
      });

      // Load details for each scene to get images + seeds
      const pages = [];
      for (const pid of sortedScenes) {
        const scene = sceneMap[pid];
        const pageModels = [];

        for (const [model, exp] of Object.entries(scene.models)) {
          try {
            const detail = await this._loadExperimentCached(exp.id);
            if (!detail) continue;
            const images = (detail.images || []).map((img, idx) => ({
              ...img,
              _index: idx,
              _seed: this._extractSeed(img.name),
              _model: model,
              _experiment: detail,
            }));
            for (const img of images) {
              if (img._seed) seedSet.add(img._seed);
            }
            pageModels.push({ model, experiment: exp, detail, images });
          } catch (e) {
            // skip failed loads
          }
        }

        if (pageModels.length > 0) {
          pageModels.sort((a, b) => a.model.localeCompare(b.model));
          pages.push({
            id: pid,
            prompt_id: pid,
            scene: pid,
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

    /** Get current page object */
    bookCurrentPage() {
      return this.book.pages[this.book.currentPage] || null;
    },

    /** Get current image for the selected model+seed on current page */
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

    bookPrev() {
      if (this.book.currentPage > 0) this.book.currentPage--;
    },

    bookNext() {
      if (this.book.currentPage < this.book.pages.length - 1) this.book.currentPage++;
    },

    bookSelectModel(model) {
      this.book.selectedModel = model;
    },

    bookSelectSeed(seed) {
      this.book.selectedSeed = seed;
    },

    /** Open lightbox from book with all seed images for current page+model */
    bookOpenLightbox() {
      const images = this.bookSeedImages();
      const idx = images.findIndex(img => img._seed === this.book.selectedSeed);
      const exp = this.bookCurrentExperiment();
      this.openLightbox(Math.max(0, idx), 'book', images, exp);
    },
  };
}
