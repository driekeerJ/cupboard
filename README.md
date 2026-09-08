# Pantry

Plan your meals for the week, scale recipes to the number of people eating, and
turn the result into a grocery list — all from plain Markdown notes in your vault.

## Status

Early development. The weekly planner is being built first; recipe scaling,
ingredient matching and grocery lists follow.

## How it works

- **Recipes** are ordinary notes in one folder you choose. Frontmatter fields
  (`duration`, `type`, anything you like) are used for filtering and can be shown
  on the recipe cards.
- **Meals** are yours to define. Name them whatever fits your household and put
  them in whatever order you want.
- **Weekly plans** are stored as one note per week. The plan itself lives in a
  `meal-plan` code block in the body of the note, which renders as the planner.
- **Household members** each have a portion factor, so a child can count as half
  an adult portion. Tick who eats what and Pantry works out the servings.
- **Shopping lists** are one note each, for one trip: pick the day, the shops
  and the planned meals it covers, check what is in the house, and shop. Several
  lists can be open at once — Lidl tomorrow, a delivery the day after — and a
  meal belongs to at most one of them.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # type-check and produce a minified main.js
```

## License

MIT
