# lamb-review-action

LambReviewAction is a GitHub Action developed by blcklamb that streamlines your code review process with ease and efficiency using OPENAI API

## example

```yaml
# Example usage of the action
example:
  - uses: blcklamb/lamb-review-action@v1.0.2
    with:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      openai_api_model: "gpt-4" # Optional: defaults to "gpt-4"
      review_rules: "{"language":"typescript","framework":"nextjs"}" # Optional: defaults to "{ 'max_code_length': 100, 'max_code_lines': 10, 'max_code_complexity': 5 }"
      exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas

```
