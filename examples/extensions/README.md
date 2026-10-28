# Extension examples

These minimal add-ons are intentionally boring: each has the smallest useful
bundle for its kind and can be copied as a starting point. From a Sulla
Desktop checkout, create the corresponding local artifact with
`marketplace/scaffold`, then validate it with `marketplace/validate` after the
scaffold has been saved to the local library.

| Example | Kind | Files |
|---|---|---|
| `hello-skill` | skill | `SKILL.md` |
| `hello-function-python` | function | `function.yaml`, `main.py` |
| `hello-function-node` | function | `function.yaml`, `main.js` |
| `hello-workflow` | workflow | `routine.yaml` |
| `hello-recipe` | recipe | `installation.yaml`, `docker-compose.yml` |

The examples do not publish anything. Publishing is a separate, reviewed step.
