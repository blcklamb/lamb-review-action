import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { readFileSync } from "fs";
import { minimatch } from "minimatch";
import OpenAI from "openai";
import parseDiff, { Chunk, File } from "parse-diff";

const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL = core.getInput("openai_api_model");
const REVIEW_RULES = core.getInput("review_rules");
const EXCLUDE_PATTERNS = core
  .getInput("exclude")
  .split(",")
  .map((s) => s.trim());

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PullRequestDetail {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  title: string;
  description: string;
}

async function getPullRequestDetail(): Promise<PullRequestDetail> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );
  const pullRequestResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });

  return {
    owner: repository.owner.login,
    repo: repository.name,
    pullRequestNumber: number,
    title: pullRequestResponse.data.title,
    description: pullRequestResponse.data.body ?? "",
  };
}

async function getDiff(owner: string, repo: string, pullRequestNumber: number) {
  const diffResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullRequestNumber,
  });

  return JSON.stringify(diffResponse.data);
}

interface CommentByAiResponse {
  lineNumber: string;
  reviewComment: string;
}

async function getAIResponse(
  prompt: string
): Promise<CommentByAiResponse[] | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.7, // Increased temperature for more diverse responses
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0.5, // Increased penalty to reduce repetition
    presence_penalty: 0,
  };
  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });
    const result = response.choices[0].message.content?.trim() || "{}";

    let parsedResult;

    try {
      parsedResult = JSON.parse(result);
    } catch (parsedError) {
      console.error("🚧 Error parsing response:", parsedError);
      return null;
    }

    if (!Array.isArray(parsedResult.reviews)) {
      console.error("🚧 Invalid response format:", parsedResult);
      return null;
    }

    return parsedResult.reviews;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function createPrompt(
  file: File,
  chunk: Chunk,
  pullRequestDetail: PullRequestDetail
): string {
  const reviewRulesObject = JSON.parse(REVIEW_RULES)
    ? JSON.parse(REVIEW_RULES)
    : {};

  const language = reviewRulesObject.language
    ? reviewRulesObject.language
    : "code";
  const framework = reviewRulesObject.framework
    ? reviewRulesObject.framework
    : "";

  return `Your task is to review pull requests. Instructions:
-   Provide the response in the following JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}
-   Do not give positive comments or compliments.
-   Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
-   Write the comment in GitHub Markdown format.
-   Use the given description only for the overall context and only comment on the code.
-   IMPORTANT: NEVER suggest adding comments to the code.
-   Consider the specifics of the ${language} language ${framework ? `and the ${framework} framework` : ""} when making your review.
-   Pay attention to and correct any typos in the code.
-   Identify and correct any linting issues according to the standard conventions for the ${language} language ${framework ? `(and the ${framework} framework)` : ""}.

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.

Pull request title: ${pullRequestDetail.title}
Pull request description:

---
${pullRequestDetail.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  .map((c) => {
    if (c.type === "normal") return `${c.ln1},${c.ln2} ${c.content}`;
    if (c.type === "add") return `+${c.ln} ${c.content}`;
    if (c.type === "del") return `-${c.ln} ${c.content}`;
  })
  .join("\n")}
\`\`\`
`;
}

function convertToComment(
  file: File,
  aiResponse: CommentByAiResponse[]
): GitComment[] {
  return aiResponse.flatMap((response) => {
    if (!file.to) return [];
    return {
      body: response.reviewComment,
      path: file.to,
      line: Number(response.lineNumber),
    };
  });
}

interface GitComment {
  body: string;
  path: string;
  line: number;
}

async function analyzePullRequest(
  parsedDiff: File[],
  pullRequestDetail: PullRequestDetail
) {
  const comments: GitComment[] = [];
  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, pullRequestDetail);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = convertToComment(file, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pullRequestNumber: number,
  comments: GitComment[]
) {
  return await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullRequestNumber,
    event: "COMMENT",
    comments: comments,
  });
}

async function main() {
  const pullRequestDetail = await getPullRequestDetail();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      pullRequestDetail.owner,
      pullRequestDetail.repo,
      pullRequestDetail.pullRequestNumber
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSHA = eventData.before;
    const newHeadSHA = eventData.after;

    const octokit = new Octokit({
      auth: GITHUB_TOKEN,
    });
    const response = await octokit.repos.compareCommits({
      owner: pullRequestDetail.owner,
      repo: pullRequestDetail.repo,
      base: newBaseSHA,
      head: newHeadSHA,
    });

    diff = JSON.stringify(response.data);
  } else {
    console.error(
      "🚧 Unsupported event action:",
      process.env.GITHUB_EVENT_NAME
    );
    return;
  }

  if (!diff) {
    console.error("🚧 No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const filteredDiff = parsedDiff.filter((file) => {
    return !EXCLUDE_PATTERNS.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzePullRequest(filteredDiff, pullRequestDetail);
  if (comments.length > 0) {
    await createReviewComment(
      pullRequestDetail.owner,
      pullRequestDetail.repo,
      pullRequestDetail.pullRequestNumber,
      comments
    );
  }
}

main().catch((error) => {
  core.setFailed(error.message);
  process.exit(1);
});
