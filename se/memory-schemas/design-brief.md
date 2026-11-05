# Design Brief Memory Schema

**Memory key:** `design-brief`  
**Written by:** `requirements-engineer`, `ux-lead`  
**Read by:** `visual-ui-designer`, `interaction-designer`, `frontend-lead`, `frontend-performance-engineer`, `frontend-state-engineer`, `frontend-accessibility-engineer`

## Schema

```yaml
design-brief:
  version: 1
  product_category: >-
    One of: saas-dashboard | consumer-app | fintech | e-commerce | robotics |
    developer-tool | marketing-site | mobile-app | other

  style_preferences:
    mood: >-
      One or more: minimal | bold | playful | corporate | technical | warm |
      futuristic | luxury | approachable
    color_palette:
      primary: "#hex or null if not specified"
      secondary: "#hex or null if not specified"
      background: "#hex or null if not specified"
      notes: "e.g., 'user said dark mode preferred', 'avoid green'"
    typography:
      preferred_fonts: ["Inter", "null if not specified"]
      style_notes: "e.g., 'modern sans-serif', 'geometric', 'humanist'"
    effects:
      three_d: true | false
      glassmorphism: true | false
      gradients: true | false
      animations: minimal | moderate | rich
      notes: "e.g., 'user mentioned they like Framer-style animations'"

  reference_urls:
    # 3-5 URLs found by web search matching the product category and style
    - url: "https://..."
      what_to_take: "e.g., the sidebar navigation pattern, the data density"

  chosen_direction:
    name: "e.g., 'Kinetic Dark'"
    description: "One paragraph describing the visual direction"
    rationale: "Why this direction fits the product category and user preferences"

  product_context:
    primary_action: "The single most important thing a user does in this product"
    user_type: "e.g., 'enterprise admin', 'consumer', 'developer'"
    hard_constraints:
      - "e.g., must work in dark mode"
      - "must be WCAG 2.1 AA compliant"
      - "must load in under 2 seconds on 4G"

  confirmed_by_user: true | false
  confirmed_at: "ISO 8601 timestamp"
```

## Validation rules

- `confirmed_by_user` must be `true` before any implementation role reads this brief
- `chosen_direction` must be present (not null) before frontend-lead unblocks
- If `product_category` is `fintech`, accessibility must be in `hard_constraints`
- Reference URLs must be present (minimum 1) — no direction from memory alone

## Who writes it and when

1. `requirements-engineer` writes an initial partial brief from the user's prompt during context intake
2. `ux-lead` fills out `reference_urls` and `chosen_direction` after the discovery step
3. The brief is not complete until `confirmed_by_user: true`

## Who reads it and how

Every design/frontend role reads the design-brief from memory at the start of their working procedure. If the brief is absent or `confirmed_by_user: false`, the role must escalate to `ux-lead` before proceeding — no guessing at visual direction.
