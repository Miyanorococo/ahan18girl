/**
 * Compare mode mixin for Alpine.js gallery component.
 * Side-by-side experiment comparison with optional seed matching
 * and synchronized scrolling.
 */
function compareMixin() {
  return {
    compareLeft: '',
    compareRight: '',
    compareLeftImages: [],
    compareRightImages: [],
    compareLeftData: null,
    compareRightData: null,
    _scrollSyncing: false,

    async loadCompareExperiment(side) {
      const id = side === 'left' ? this.compareLeft : this.compareRight;
      if (!id) {
        if (side === 'left') {
          this.compareLeftImages = [];
          this.compareLeftData = null;
        } else {
          this.compareRightImages = [];
          this.compareRightData = null;
        }
        return;
      }

      try {
        const data = await GalleryAPI.getExperiment(id);
        const images = (data.images || []).map((img, i) => ({
          ...img,
          _index: i,
          _seed: this._extractSeed(img.name),
        }));

        if (side === 'left') {
          this.compareLeftData = data;
          this.compareLeftImages = images;
        } else {
          this.compareRightData = data;
          this.compareRightImages = images;
        }

        this._initScrollSync();
      } catch (e) {
        console.error(`Failed to load experiment ${id} for compare:`, e);
      }
    },

    /**
     * Add an experiment to the next empty compare slot.
     * Called from experiment detail view.
     */
    addToCompare(id) {
      if (!id) return;
      if (!this.compareLeft) {
        this.compareLeft = id;
      } else if (!this.compareRight) {
        this.compareRight = id;
      } else {
        // Both slots full - replace the right one
        this.compareRight = id;
      }
      this.navigate('compare');
    },

    /**
     * Extract seed number from filename.
     * Common patterns: "seed_12345.png", "img_12345_seed42.webp", etc.
     */
    _extractSeed(filename) {
      if (!filename) return null;
      const match = filename.match(/\bseed[_-]?(\d+)/i);
      return match ? match[1] : null;
    },

    /**
     * Set up synchronized scrolling between the two compare panels.
     */
    _initScrollSync() {
      const left = document.getElementById('compare-left');
      const right = document.getElementById('compare-right');
      if (!left || !right) return;

      const sync = (source, target) => {
        if (this._scrollSyncing) return;
        this._scrollSyncing = true;
        const ratio = source.scrollTop / (source.scrollHeight - source.clientHeight || 1);
        target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
        requestAnimationFrame(() => {
          this._scrollSyncing = false;
        });
      };

      // Remove old listeners by cloning nodes (simple approach for re-init)
      left.onscroll = () => sync(left, right);
      right.onscroll = () => sync(right, left);
    },
  };
}
