/**
 * Lightbox mixin for Alpine.js gallery component.
 * Full-screen image viewing with keyboard navigation, 5-axis evaluation,
 * comments, and training data save functionality.
 */
function lightboxMixin() {
  return {
    lightbox: {
      open: false,
      images: [],
      index: 0,
      currentImage: null,
      source: null,         // null | 'left' | 'right' | 'model-grid'
      sourceExperiment: null, // experiment object for context
    },

    // Evaluation panel state
    evalPanel: {
      expanded: true,
      commentDraft: '',
      _commentTimer: null,
    },

    // Save panel state
    savePanel: {
      open: false,
      selectedLabels: [],
      customLabelInput: '',
      saving: false,
      saved: false,
    },

    // Favorite (heart) state - per image
    _favSaving: false,

    openLightbox(index, source, images, experiment) {
      let imgList;
      if (images) {
        imgList = images;
      } else if (source === 'left') {
        imgList = this.compareLeftImages;
      } else if (source === 'right') {
        imgList = this.compareRightImages;
      } else {
        imgList = this.currentExperiment?.images || [];
      }
      if (!imgList.length) return;

      this.lightbox.images = imgList;
      this.lightbox.index = Math.max(0, Math.min(index, imgList.length - 1));
      this.lightbox.source = source || null;
      this.lightbox.sourceExperiment = experiment || this.currentExperiment;
      this.lightbox.open = true;
      this._updateLightboxImage();
      document.body.style.overflow = 'hidden';
    },

    closeLightbox() {
      this.lightbox.open = false;
      this.lightbox.currentImage = null;
      this.savePanel.open = false;
      document.body.style.overflow = '';
    },

    lightboxPrev() {
      if (!this.lightbox.open) return;
      const len = this.lightbox.images.length;
      this.lightbox.index = (this.lightbox.index - 1 + len) % len;
      this._updateLightboxImage();
    },

    lightboxNext() {
      if (!this.lightbox.open) return;
      const len = this.lightbox.images.length;
      this.lightbox.index = (this.lightbox.index + 1) % len;
      this._updateLightboxImage();
    },

    _updateLightboxImage() {
      const images = this.lightbox.images;
      const idx = this.lightbox.index;
      const img = images[idx] || null;
      this.lightbox.currentImage = img;
      this._preloadAdjacent(images, idx);

      // For model-grid cross-model navigation, update sourceExperiment per image
      if (this.lightbox.source === 'model-grid' && img?._mgExperiment) {
        this.lightbox.sourceExperiment = img._mgExperiment;
      }

      // Sync comment draft with stored comment
      const comment = this.getImageComment(this.lightbox.currentImage);
      this.evalPanel.commentDraft = comment;

      // Reset save panel
      this.savePanel.open = false;
      this.savePanel.saved = false;
    },

    _preloadAdjacent(images, idx) {
      const len = images.length;
      if (len <= 1) return;
      const prevIdx = (idx - 1 + len) % len;
      const nextIdx = (idx + 1) % len;
      [prevIdx, nextIdx].forEach((i) => {
        const url = images[i]?.full_url;
        if (url) {
          const img = new Image();
          img.src = url;
        }
      });
    },

    // --- Evaluation panel methods ---
    onCommentInput(value) {
      this.evalPanel.commentDraft = value;
      clearTimeout(this.evalPanel._commentTimer);
      this.evalPanel._commentTimer = setTimeout(() => {
        this.setImageComment(this.lightbox.currentImage, value);
      }, 1500);
    },

    // --- Save panel methods ---
    openSavePanel() {
      this.savePanel.open = true;
      this.savePanel.selectedLabels = [];
      this.savePanel.customLabelInput = '';
      this.savePanel.saving = false;
      this.savePanel.saved = false;
    },

    closeSavePanel() {
      this.savePanel.open = false;
    },

    toggleSaveLabel(label) {
      const idx = this.savePanel.selectedLabels.indexOf(label);
      if (idx >= 0) {
        this.savePanel.selectedLabels.splice(idx, 1);
      } else {
        this.savePanel.selectedLabels.push(label);
      }
    },

    isSaveLabelSelected(label) {
      return this.savePanel.selectedLabels.includes(label);
    },

    addCustomLabel() {
      const label = this.savePanel.customLabelInput.trim().toLowerCase().replace(/\s+/g, '-');
      if (!label) return;
      if (!this._customLabels) this._customLabels = [];
      if (!this._customLabels.includes(label)) {
        this._customLabels.push(label);
        localStorage.setItem('gallery_custom_labels', JSON.stringify(this._customLabels));
      }
      if (!this.savePanel.selectedLabels.includes(label)) {
        this.savePanel.selectedLabels.push(label);
      }
      this.savePanel.customLabelInput = '';
    },

    getAllSaveLabels() {
      const presets = this.SAVE_LABEL_PRESETS || [];
      const custom = this._customLabels || [];
      return [...new Set([...presets, ...custom])];
    },

    // --- Heart (favorite) toggle ---
    isImageFavorited(img) {
      const key = this._ratingKey(img);
      return key ? !!this.ratings.images?.[key]?.favorited : false;
    },

    async toggleFavorite(img, experiment) {
      const key = this._ratingKey(img);
      if (!key || this._favSaving) return;

      const exp = experiment || this.lightbox.sourceExperiment || this.currentExperiment;
      if (!exp) return;

      const entry = this.ratings.images[key] || { scores: {}, comment: '', updated_at: '' };
      const wasFavorited = !!entry.favorited;

      // Toggle locally immediately for UI responsiveness
      if (!this.ratings.images[key]) {
        this.ratings.images[key] = entry;
      }
      this.ratings.images[key].favorited = !wasFavorited;
      this.ratings.images[key].updated_at = new Date().toISOString();
      this._persistRatings();

      // If newly favorited, save to training-data + auto-advance
      if (!wasFavorited) {
        this._favSaving = true;
        try {
          const metadata = {
            scores: entry.scores || {},
            comment: entry.comment || '',
          };
          await GalleryAPI.saveToTraining(
            exp.id,
            [img.name],
            ['favorite'],
            metadata
          );
        } catch (e) {
          console.error('Failed to save favorite to training:', e);
        }
        this._favSaving = false;

        if (this.autoAdvance && this.lightbox.open) {
          const active = document.activeElement;
          if (!active || !active.matches('textarea, input[type="text"]')) {
            setTimeout(() => this.lightboxNext(), 300);
          }
        }
      }
    },

    async executeSave() {
      const img = this.lightbox.currentImage;
      const exp = this.lightbox.sourceExperiment;
      if (!img || !exp || this.savePanel.selectedLabels.length === 0) return;

      this.savePanel.saving = true;
      try {
        const metadata = {
          scores: this.ratings.images?.[this._ratingKey(img)]?.scores || {},
          comment: this.getImageComment(img),
        };
        await GalleryAPI.saveToTraining(
          exp.id,
          [img.name],
          this.savePanel.selectedLabels,
          metadata
        );
        this.savePanel.saved = true;
        this.savePanel.saving = false;
      } catch (e) {
        console.error('Failed to save to training:', e);
        this.savePanel.saving = false;
        alert('Save failed. Please try again.');
      }
    },
  };
}
