# Gallery Architecture

## Frontend (Alpine.js SPA)
- gallery/index.html - SPA entry
- gallery/js/app.js - Main (routing, ratings, filters, 4-tier eval ★5/♥2/👎-1)
- gallery/js/lightbox.js - Carousel lightbox (prev/current/next, slide animation)
- gallery/js/model-grid.js - N-model comparison (cross-model nav, alphabetical order)
- gallery/js/dashboard.js - KPI cards, heatmap (AI score), insights, export
- gallery/js/compare.js - 2-panel compare
- gallery/js/knowledge-base.js - Genre×model recommendation
- gallery/js/api.js - API client
- gallery/js/utils.js - Helpers (formatDate, displayModelName)

## Backend (Lambda)
- lambda/gallery/lambda_function.py - Router (API GW + S3 Event)
- lambda/gallery/routes/extract.py - Zip extract + thumbnail + AI scoring + genre inference
- lambda/gallery/routes/experiments.py - GET experiments list/detail
- lambda/gallery/routes/ratings.py - GET/PUT ratings
- lambda/gallery/routes/select.py - POST select/delete/training-data save
- lambda/gallery/services/image_scorer.py - anime-aesthetic ONNX scoring
- lambda/gallery/services/genre_inference.py - Bedrock Haiku genre inference
- lambda/gallery/services/index_builder.py - index.json builder
- Lambda: 3GB RAM, 900s timeout, ONNX Runtime Layer

## Rating System
- 4-tier: ★Best(5) / ♥Like(2) / Skip(0) / 👎Bad(-1)
- Keyboard: S / F / → / D
- Auto-advance after rating
- AI aesthetic score (0-1) displayed but NOT used for quality judgment
- AI score inversely correlates with human rating in NSFW context

## S3 Structure
- gallery/experiments/{id}/metadata.json (model, prompt, aesthetic_scores, aesthetic_avg, genre)
- gallery/experiments/{id}/full/*.png
- gallery/experiments/{id}/thumb/*.webp
- gallery/experiments/index.json (all experiments)
- gallery/user-data/ratings.json (human ratings)
