#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Octokit } = require("@octokit/rest");
const semver = require("semver");

// Registry configuration
const REGISTRY_URL =
  "https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json";

// Helper function to safely fetch JSON
async function safeFetchJSON(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    // Only filter if data is a record-like object
    if (data && typeof data === "object" && !Array.isArray(data)) {
      // Filter out entries with empty keys or comment-like entries
      const filtered = {};
      for (const [key, value] of Object.entries(data)) {
        if (key && !key.startsWith("") && typeof value === "string") {
          filtered[key] = value;
        }
      }
      return filtered;
    }
    return data;
  } catch {
    return null;
  }
}

// Parse GitHub reference
function parseGitRef(gitRef) {
  if (!gitRef.startsWith("github:")) return null;
  const repoPath = gitRef.slice("github:".length);
  const [owner, repo] = repoPath.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

// Get GitHub branches
async function getGitHubBranches(owner, repo, octokit) {
  try {
    const { data } = await octokit.rest.repos.listBranches({ owner, repo });
    return data.map((b) => b.name);
  } catch {
    return [];
  }
}

// Fetch package.json from GitHub
async function fetchPackageJSON(owner, repo, ref, octokit) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: "package.json",
      ref,
    });
    if (!("content" in data)) return null;
    const pkg = JSON.parse(Buffer.from(data.content, "base64").toString());
    const coreRange =
      pkg.dependencies?.["@elizaos/core"] ||
      pkg.peerDependencies?.["@elizaos/core"] ||
      undefined;
    return { version: pkg.version, coreRange };
  } catch {
    return null;
  }
}

// Get latest Git tags
async function getLatestGitTags(owner, repo, octokit) {
  try {
    const { data } = await octokit.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
    });
    const versions = data.map((t) => semver.clean(t.name)).filter(Boolean);
    const sorted = versions.sort(semver.rcompare);
    const latestV0 = sorted.find((v) => semver.major(v) === 0);
    const latestV1 = sorted.find((v) => semver.major(v) === 1);
    return {
      repo: `${owner}/${repo}`,
      v0: latestV0 || null,
      v1: latestV1 || null,
    };
  } catch (error) {
    console.warn(`Failed to get tags for ${owner}/${repo}:`, error.message);
    return { repo: `${owner}/${repo}`, v0: null, v1: null };
  }
}

// Inspect NPM package
async function inspectNpm(pkgName) {
  const meta = await safeFetchJSON(`https://registry.npmjs.org/${pkgName}`);
  if (!meta || !meta.versions) {
    return { repo: pkgName, v0: null, v1: null };
  }
  const versions = Object.keys(meta.versions);
  const sorted = versions.sort(semver.rcompare);
  const v0 = sorted.find((v) => semver.major(v) === 0) || null;
  const v1 = sorted.find((v) => semver.major(v) === 1) || null;
  return {
    repo: pkgName,
    v0,
    v1,
  };
}

// Guess NPM name from JS name
function guessNpmName(jsName) {
  return jsName.replace(/^@elizaos-plugins\//, "@elizaos/");
}

// Process a single repository
async function processRepo(npmId, gitRef, octokit) {
  const parsed = parseGitRef(gitRef);
  if (!parsed) {
    throw new Error(`Invalid git reference: ${gitRef}`);
  }
  const { owner, repo } = parsed;

  console.log(`Processing ${npmId} (${owner}/${repo})`);

  // Kick off remote calls
  const branchesPromise = getGitHubBranches(owner, repo, octokit);
  const tagsPromise = getLatestGitTags(owner, repo, octokit);
  const npmPromise = inspectNpm(guessNpmName(npmId));

  // Support detection via package.json across relevant branches
  const branches = await branchesPromise;
  const branchCandidates = ["main", "master", "0.x", "1.x"].filter((b) =>
    branches.includes(b)
  );

  const pkgPromises = branchCandidates.map((br) =>
    fetchPackageJSON(owner, repo, br, octokit)
  );
  const pkgResults = await Promise.allSettled(pkgPromises);

  const pkgs = [];
  const supportedBranches = {
    v0: null,
    v1: null,
  };

  for (let i = 0; i < pkgResults.length; i++) {
    const result = pkgResults[i];
    if (result.status === "fulfilled" && result.value) {
      const branch = branchCandidates[i];
      const pkg = result.value;
      pkgs.push({ ...pkg, branch });
    }
  }

  let supportsV0 = false;
  let supportsV1 = false;

  for (const pkg of pkgs) {
    if (pkg.coreRange) {
      const satisfiesV0 = semver.satisfies("0.9.0", pkg.coreRange);
      const satisfiesV1 = semver.satisfies("1.0.0", pkg.coreRange);

      if (satisfiesV0) {
        supportsV0 = true;
        supportedBranches.v0 = pkg.branch;
      }
      if (satisfiesV1) {
        supportsV1 = true;
        supportedBranches.v1 = pkg.branch;
      }
    }
  }

  const [gitTagInfo, npmInfo] = await Promise.all([tagsPromise, npmPromise]);

  // Set version support based on npm versions
  if (npmInfo?.v0) {
    supportsV0 = true;
  }
  if (npmInfo?.v1) {
    supportsV1 = true;
  }

  console.log(`${npmId} → v0:${supportsV0} v1:${supportsV1}`);

  // Prepare git info with versions and branches
  const gitInfo = {
    repo: gitTagInfo?.repo || npmInfo?.repo || `${owner}/${repo}`,
    v0: {
      version: gitTagInfo?.v0 || npmInfo?.v0 || null,
      branch: supportedBranches.v0,
    },
    v1: {
      version: gitTagInfo?.v1 || npmInfo?.v1 || null,
      branch: supportedBranches.v1,
    },
  };

  // Set version support flags based on both branch detection and npm versions
  supportsV0 = supportsV0 || !!supportedBranches.v0;
  supportsV1 = supportsV1 || !!supportedBranches.v1;

  return [
    npmId,
    {
      git: gitInfo,
      npm: npmInfo,
      supports: { v0: supportsV0, v1: supportsV1 },
    },
  ];
}

// Main function to parse registry
async function parseRegistry(githubToken) {
  const octokit = new Octokit({ auth: githubToken });

  // Read local index.json file instead of fetching from URL
  const indexPath = path.join(__dirname, "..", "index.json");
  let registry;

  try {
    const indexContent = fs.readFileSync(indexPath, "utf8");
    registry = JSON.parse(indexContent);
  } catch (error) {
    console.error("Failed to read index.json:", error);
    return null;
  }

  // Filter out comment entries
  const filteredRegistry = {};
  for (const [key, value] of Object.entries(registry)) {
    if (key && !key.startsWith("") && typeof value === "string") {
      filteredRegistry[key] = value;
    }
  }

  const report = {};

  const tasks = Object.entries(filteredRegistry).map(([npmId, gitRef]) =>
    processRepo(npmId, gitRef, octokit)
  );

  const results = await Promise.all(tasks);
  for (const [id, info] of results) {
    report[id] = info;
  }

  return {
    lastUpdatedAt: new Date().toISOString(),
    registry: report,
  };
}

// Main execution
async function main() {
  const githubToken = process.env.GITHUB_TOKEN;

  if (!githubToken) {
    console.error("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  try {
    console.log("Starting registry generation...");
    const result = await parseRegistry(githubToken);

    if (!result) {
      console.error("Failed to generate registry");
      process.exit(1);
    }

    const outputPath = path.join(__dirname, "..", "generated-registry.json");
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

    console.log(`Registry generated successfully: ${outputPath}`);
    console.log(`Generated ${Object.keys(result.registry).length} entries`);
  } catch (error) {
    console.error("Error generating registry:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
