const GalleryAPI = {
  async fetchJSON(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    return res.json();
  },

  getExperiments(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.fetchJSON(`/api/experiments${qs ? '?' + qs : ''}`);
  },

  getBooks() {
    return this.fetchJSON('/api/books');
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
   * Infer genre from prompt using Bedrock LLM.
   * @param {string} promptText - Full prompt text
   * @param {string} promptSummary - Optional prompt summary
   * @returns {Promise<Object>} Genre inference result
   */
  inferGenre(promptText, promptSummary = '') {
    return this.fetchJSON('/api/infer-genre', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_text: promptText, prompt_summary: promptSummary }),
    });
  },

  deleteExperiment(experimentId) {
    return this.fetchJSON('/api/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experiment_id: experimentId,
        action: 'delete-experiment',
      }),
    });
  },

  /**
   * Save images to training-data/ with labels.
   * @param {string} experimentId - Source experiment ID
   * @param {string[]} images - Image filenames
   * @param {string[]} labels - Labels to apply
   * @param {object} metadata - Extra metadata (scores, comment, etc.)
   * @returns {Promise<Object>}
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

  /**
   * Start regeneration for flagged pages.
   * @param {string} bookId - Book ID
   * @param {Array} pages - [{pageId, prompt, genre, type}]
   * @param {Array} [models] - Optional model filter
   * @param {Array} [seeds] - Optional seeds
   * @returns {Promise<Object>} {status, executionName, executionArn, ...}
   */
  startRegeneration(bookId, pages, models = [], seeds = [42, 123, 456]) {
    return this.fetchJSON('/api/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookId, pages, models, seeds }),
    });
  },

  /**
   * Check regeneration status.
   * @param {string} arn - Step Functions execution ARN
   * @returns {Promise<Object>} {status: 'RUNNING'|'SUCCEEDED'|'FAILED'|'ABORTED', ...}
   */
  getRegenerationStatus(arn) {
    return this.fetchJSON(`/api/regenerate-status?arn=${encodeURIComponent(arn)}`);
  },
};
