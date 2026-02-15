const GalleryAPI = {
  async fetchJSON(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },

  getExperiments() {
    return this.fetchJSON('/api/experiments');
  },

  getExperiment(id) {
    return this.fetchJSON(`/api/experiments/${encodeURIComponent(id)}`);
  },

  getProductions() {
    return this.fetchJSON('/api/productions');
  },

  getProduction(id) {
    return this.fetchJSON(`/api/productions/${encodeURIComponent(id)}`);
  },

  getRatings() {
    return this.fetchJSON('/api/ratings');
  },

  saveRatings(ratings) {
    return this.fetchJSON('/api/ratings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ratings),
    });
  },

  selectImages(experimentId, productionId, images) {
    return this.fetchJSON('/api/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experiment_id: experimentId,
        production_id: productionId,
        images,
      }),
    });
  },

  /**
   * Save images to training-data/ with labels.
   * @param {string} experimentId - Source experiment ID
   * @param {string[]} images - Image filenames
   * @param {string[]} labels - Labels to apply
   * @param {object} metadata - Extra metadata (scores, comment, etc.)
   */
  saveToTraining(experimentId, images, labels, metadata = {}) {
    return this.fetchJSON('/api/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experiment_id: experimentId,
        action: 'save-training',
        images,
        labels,
        metadata,
      }),
    });
  },
};
