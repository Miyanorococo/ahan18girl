# Session 2026-02-16 Summary

## Key Changes
- Gallery: 5-axis → 4-tier rating (★5/♥2/👎-1), carousel lightbox, cross-model grid nav
- AI Scoring: anime-aesthetic ONNX on Lambda (3GB, 1651/1652 scored), auto on zip extract
- **AI score ≠ human rating (inverse correlation)** → AI = defect filter only
- Prompts: v2.4 (dark→bright, negative→positive, +embarrassment, +dynamic tags)
- Top models (human eval 433 images): Nova(★21/120=18%), Animagine(★21/100=21%), Rouwei(★5/58=9%)
- birth type: ★0, 👎53% → remove from prompts
- Tests: fucked_silly(13 models DONE), dynamic(4 models IN PROGRESS)

## Architecture
- Gallery: Alpine.js SPA on S3+CloudFront, Lambda API, Bedrock genre inference
- AI Scorer: anime-aesthetic ONNX (Lambda Layer, 3GB RAM, 900s timeout)
- Batch: AWS Batch + Step Functions (13 models parallel on g6 Spot)
- Prompts: eval-prompts-v2-unified-anime.json (v2.4, 122 prompts)

## Model Selection (Human Eval)
| Model | ★ | ♥ | 👎 | ★Rate | Recommendation |
|-------|---|---|---|-------|----------------|
| Animagine XL 4.0 | 21 | 68 | 11 | 21% | Main candidate B |
| Nova Anime XL | 21 | 93 | 6 | 18% | Main candidate A |
| WAI Branch-Rouwei | 5 | 50 | 3 | 9% | NSFW specialist |
| WAI v11-v16 | 2-5 | 17-34 | 2-4 | 0-6% | On hold |
| Pony/Illustrij/SD1.5 | 0 | 0-1 | 1-3 | 0% | Eliminated |

## Next Actions
1. Continue ♥ scanning (433/7000+ = 6%)
2. Remove birth prompts
3. Character consistency test (#10) with Nova + Animagine
4. Switch heatmap from AI to human rating
5. Stop g5 instance when not needed (cost)

## Key Files
- Gallery: gallery/js/{app,dashboard,lightbox,model-grid}.js
- Lambda: lambda/gallery/{lambda_function,routes/extract,services/image_scorer}.py
- Prompts: assets/templates/eval-prompts-*.json
- Docs: Obsidian AI出版戦略/21-28_*.md
