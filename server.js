import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
let PORT = parseInt(process.env.PORT || '3001', 10);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Helper to safely parse response from Azure DevOps REST API
 */
async function parseAdoResponse(response, { org, project, contextDesc }) {
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  // If Azure DevOps redirects to login.microsoftonline.com or returns HTML
  if (response.redirected || !contentType.includes('application/json') || text.trim().startsWith('<')) {
    throw new Error(
      `Azure DevOps afviste anmodningen og omdirigerede til login-siden. Kontroller venligst at:\n` +
      `1) Dit PAT token er gyldigt og ikke udløbet.\n` +
      `2) PAT tokenet har 'Work Items: Read & Write' tilladelse.\n` +
      `3) Organisation ('${org}') og Projekt ('${project}') er stavet 100% korrekt.`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Ugyldigt svar fra Azure DevOps: ${text.slice(0, 150)}`);
  }

  if (!response.ok) {
    const message = data.message || data.value || text;
    throw new Error(`${contextDesc}: ${message} (Status ${response.status})`);
  }

  return data;
}

/**
 * Creates an item in Azure DevOps via REST API
 */
async function createWorkItem({ org, project, pat, type, title, description, tags, parentUrl }) {
  const typeName = type.startsWith('$') ? type : `$${type}`;
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${encodeURIComponent(typeName)}?api-version=7.1-preview.3`;

  const patchDocument = [
    {
      op: 'add',
      path: '/fields/System.Title',
      value: title || 'Untitled'
    }
  ];

  if (description) {
    patchDocument.push({
      op: 'add',
      path: '/fields/System.Description',
      value: description
    });
  }

  if (tags) {
    const formattedTags = Array.isArray(tags) ? tags.filter(Boolean).join('; ') : String(tags);
    if (formattedTags.trim()) {
      patchDocument.push({
        op: 'add',
        path: '/fields/System.Tags',
        value: formattedTags.trim()
      });
    }
  }

  if (parentUrl) {
    patchDocument.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: parentUrl
      }
    });
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json-patch+json',
      'Accept': 'application/json',
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
    },
    body: JSON.stringify(patchDocument)
  });

  return await parseAdoResponse(response, {
    org,
    project,
    contextDesc: `Kunne ikke oprette ${type} "${title}"`
  });
}

/**
 * Validates and retrieves an existing work item
 */
async function getWorkItem({ org, project, pat, id }) {
  const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1-preview.3`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
    }
  });

  return await parseAdoResponse(response, {
    org,
    project,
    contextDesc: `Work item #${id} ikke fundet eller utilgængeligt`
  });
}

// POST /api/workitem-lookup
app.post('/api/workitem-lookup', async (req, res) => {
  const { org, project, pat, id } = req.body;

  if (!org || !project || !pat || !id) {
    return res.status(400).json({ error: 'Organization, Project, PAT and ID are required.' });
  }

  try {
    const item = await getWorkItem({ org, project, pat, id });
    return res.json({
      id: item.id,
      type: item.fields?.['System.WorkItemType'] || 'Work Item',
      title: item.fields?.['System.Title'] || `Work Item #${id}`,
      state: item.fields?.['System.State'] || '',
      webUrl: item._links?.html?.href || ''
    });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

// POST /api/import
app.post('/api/import', async (req, res) => {
  const { org, project, pat, existingFeatureId, features } = req.body;

  if (!org || !project || !pat) {
    return res.status(400).json({ error: 'Organization, Project, and PAT Token are required.' });
  }

  if (!features || !Array.isArray(features) || features.length === 0) {
    return res.status(400).json({ error: 'Features payload must be a non-empty array.' });
  }

  const results = [];
  const errors = [];

  try {
    let defaultParentUrl = null;
    let existingFeatureObj = null;

    if (existingFeatureId) {
      // Validate existing feature exists
      existingFeatureObj = await getWorkItem({
        org,
        project,
        pat,
        id: existingFeatureId
      });
      defaultParentUrl = existingFeatureObj.url;
      results.push({
        id: existingFeatureObj.id,
        type: existingFeatureObj.fields?.['System.WorkItemType'] || 'Feature',
        title: existingFeatureObj.fields?.['System.Title'] || `Feature #${existingFeatureId}`,
        webUrl: existingFeatureObj._links?.html?.href || '',
        status: 'linked_existing'
      });
    }

    for (const featureData of features) {
      let featureWorkItem = null;
      let featureUrl = defaultParentUrl;

      if (!existingFeatureId) {
        // Create new Feature
        try {
          featureWorkItem = await createWorkItem({
            org,
            project,
            pat,
            type: 'Feature',
            title: featureData.title || 'New Feature',
            description: featureData.description || '',
            tags: featureData.tags
          });

          featureUrl = featureWorkItem.url;
          results.push({
            id: featureWorkItem.id,
            type: 'Feature',
            title: featureWorkItem.fields?.['System.Title'] || featureData.title,
            webUrl: featureWorkItem._links?.html?.href || '',
            status: 'created'
          });
        } catch (err) {
          errors.push({ type: 'Feature', title: featureData.title, error: err.message });
          // If feature creation fails, we can't create its stories under it
          continue;
        }
      }

      // Process User Stories
      const stories = featureData.userStories || featureData.stories || [];
      for (const storyData of stories) {
        let storyWorkItem = null;
        try {
          storyWorkItem = await createWorkItem({
            org,
            project,
            pat,
            type: 'User Story',
            title: storyData.title || 'New User Story',
            description: storyData.description || '',
            tags: storyData.tags,
            parentUrl: featureUrl
          });

          results.push({
            id: storyWorkItem.id,
            parentId: existingFeatureId || featureWorkItem?.id,
            type: 'User Story',
            title: storyWorkItem.fields?.['System.Title'] || storyData.title,
            webUrl: storyWorkItem._links?.html?.href || '',
            status: 'created'
          });
        } catch (err) {
          errors.push({ type: 'User Story', title: storyData.title, error: err.message });
          // If story creation fails, skip its tasks
          continue;
        }

        // Process Tasks
        const tasks = storyData.tasks || [];
        for (const taskData of tasks) {
          try {
            const taskWorkItem = await createWorkItem({
              org,
              project,
              pat,
              type: 'Task',
              title: taskData.title || 'New Task',
              description: taskData.description || '',
              tags: taskData.tags,
              parentUrl: storyWorkItem.url
            });

            results.push({
              id: taskWorkItem.id,
              parentId: storyWorkItem.id,
              type: 'Task',
              title: taskWorkItem.fields?.['System.Title'] || taskData.title,
              webUrl: taskWorkItem._links?.html?.href || '',
              status: 'created'
            });
          } catch (err) {
            errors.push({ type: 'Task', title: taskData.title, error: err.message });
          }
        }
      }
    }

    return res.json({
      success: errors.length === 0,
      summary: {
        totalCreated: results.filter(r => r.status === 'created').length,
        totalErrors: errors.length
      },
      results,
      errors
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || 'An unexpected error occurred during import.'
    });
  }
});

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`Azure DevOps Importer server running at http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} er i brug, forsøger port ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('Server fejl:', err);
    }
  });
}

startServer(PORT);
