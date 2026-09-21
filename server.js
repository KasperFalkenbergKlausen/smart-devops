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
  // Try collection-level first (works across projects), fallback to project-level
  const urls = [
    `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1-preview.3`,
    `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1-preview.3`
  ];

  let lastResponse = null;
  for (const url of urls) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
      }
    });

    if (response.ok) {
      return await parseAdoResponse(response, { org, project, contextDesc: `Henter work item #${id}` });
    }
    lastResponse = response;
  }

  return await parseAdoResponse(lastResponse, {
    org,
    project,
    contextDesc: `Work item #${id} ikke fundet eller utilgængeligt`
  });
}

/**
 * Unlinks all relations on the work item itself and from related parent/child work items
 */
async function unlinkRelations({ org, project, pat, id }) {
  try {
    const itemUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(id)}?$expand=relations&api-version=7.1-preview.3`;
    const res = await fetch(itemUrl, {
      headers: {
        'Accept': 'application/json',
        Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
      }
    });

    if (!res.ok) return;
    const item = await res.json();
    const relations = item.relations || [];

    // 1. Fjern relationer på andre forældre/børn work items
    for (const rel of relations) {
      if (rel.url) {
        const match = rel.url.match(/workitems\/(\d+)/i);
        if (match) {
          const relatedId = match[1];
          try {
            const relatedUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(relatedId)}?$expand=relations&api-version=7.1-preview.3`;
            const relRes = await fetch(relatedUrl, {
              headers: {
                'Accept': 'application/json',
                Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
              }
            });

            if (relRes.ok) {
              const relatedItem = await relRes.json();
              const relatedRels = relatedItem.relations || [];
              const indicesToRemove = [];
              relatedRels.forEach((r, idx) => {
                if (r.url) {
                  const rMatch = r.url.match(/workitems\/(\d+)/i);
                  if (rMatch && rMatch[1] === String(id)) {
                    indicesToRemove.push(idx);
                  }
                }
              });

              if (indicesToRemove.length > 0) {
                const patchOps = indicesToRemove.reverse().map(idx => ({
                  op: 'remove',
                  path: `/relations/${idx}`
                }));

                await fetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(relatedId)}?api-version=7.1-preview.3`, {
                  method: 'PATCH',
                  headers: {
                    'Content-Type': 'application/json-patch+json',
                    'Accept': 'application/json',
                    Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
                  },
                  body: JSON.stringify(patchOps)
                });
                console.log(`[Azure DevOps UNLINK] Fjernede link på forælder #${relatedId} til #${id}`);
              }
            }
          } catch (e) {
            console.warn(`[Azure DevOps UNLINK] Kunne ikke afkoble #${relatedId}:`, e.message);
          }
        }
      }
    }

    // 2. Fjern alle relationer på SELVE work itemet (#id)
    if (relations.length > 0) {
      const selfPatchOps = relations.map((_, idx) => ({
        op: 'remove',
        path: `/relations/${idx}`
      })).reverse();

      await fetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1-preview.3`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json-patch+json',
          'Accept': 'application/json',
          Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
        },
        body: JSON.stringify(selfPatchOps)
      });
      console.log(`[Azure DevOps UNLINK] Fjernede ${selfPatchOps.length} relation(er) på selve #${id}`);
    }
  } catch (err) {
    console.warn(`[Azure DevOps UNLINK] Advarsel ved fjernelse af relationer for #${id}:`, err.message);
  }
}

/**
 * Deletes/removes a work item: unlinks relations, clears tags, and sets State="Removed" (or "Closed")
 */
async function deleteWorkItemAdo({ org, project, pat, id }) {
  // 1. Unlink fra forældre og børn, og ryd relationer på selve elementet
  await unlinkRelations({ org, project, pat, id });

  // 2. Ryd tags og sæt status til "Removed" (eller "Closed") på selve elementet
  let finalState = 'Removed';
  let patchSuccess = false;
  let patchError = '';

  // Prøv både remove af tags og opdatering af State
  const patchAttempts = [
    [
      { op: 'remove', path: '/fields/System.Tags' },
      { op: 'add', path: '/fields/System.State', value: 'Removed' }
    ],
    [
      { op: 'add', path: '/fields/System.Tags', value: '' },
      { op: 'add', path: '/fields/System.State', value: 'Removed' }
    ],
    [
      { op: 'remove', path: '/fields/System.Tags' },
      { op: 'add', path: '/fields/System.State', value: 'Closed' }
    ],
    [
      { op: 'add', path: '/fields/System.Tags', value: '' },
      { op: 'add', path: '/fields/System.State', value: 'Closed' }
    ],
    [
      { op: 'add', path: '/fields/System.State', value: 'Removed' }
    ],
    [
      { op: 'add', path: '/fields/System.State', value: 'Closed' }
    ]
  ];

  for (const patchDoc of patchAttempts) {
    try {
      const patchRes = await fetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1-preview.3`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json-patch+json',
          'Accept': 'application/json',
          Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
        },
        body: JSON.stringify(patchDoc)
      });

      if (patchRes.ok) {
        patchSuccess = true;
        const patchedItem = await patchRes.json();
        finalState = patchedItem.fields?.['System.State'] || 'Removed';
        console.log(`[Azure DevOps REMOVE] Work item #${id} opdateret: State="${finalState}", tags ryddet.`);
        break;
      } else {
        patchError = await patchRes.text();
      }
    } catch (e) {
      patchError = e.message;
    }
  }

  if (patchSuccess) {
    return {
      ok: true,
      state: finalState,
      message: `Work item #${id} blev afkoblet, tags ryddet og status sat til '${finalState}'.`
    };
  }

  throw new Error(`Kunne ikke opdatere #${id}: ${patchError}`);
}

// POST /api/workitem/:id/clean-links (Fjern alle child relationer fra en User Story eller Feature)
app.post('/api/workitem/:id/clean-links', async (req, res) => {
  const { org, project, pat } = req.body;
  const { id } = req.params;

  if (!org || !project || !pat || !id) {
    return res.status(400).json({ error: 'Organization, Project, PAT and ID are required.' });
  }

  try {
    const itemUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(id)}?$expand=relations&api-version=7.1-preview.3`;
    const getRes = await fetch(itemUrl, {
      headers: {
        'Accept': 'application/json',
        Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
      }
    });

    if (!getRes.ok) {
      const err = await getRes.text();
      throw new Error(`Kunne ikke hente #${id}: ${err}`);
    }

    const item = await getRes.json();
    const relations = item.relations || [];
    const childIndices = [];

    relations.forEach((r, idx) => {
      if (r.rel === 'System.LinkTypes.Hierarchy-Forward' || r.name === 'Child') {
        childIndices.push(idx);
      }
    });

    const patchOps = childIndices.reverse().map(idx => ({
      op: 'remove',
      path: `/relations/${idx}`
    }));

    // Ryd tags på elementet
    patchOps.push({
      op: 'add',
      path: '/fields/System.Tags',
      value: ''
    });

    const patchRes = await fetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitems/${encodeURIComponent(id)}?api-version=7.1-preview.3`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json-patch+json',
        'Accept': 'application/json',
        Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
      },
      body: JSON.stringify(patchOps)
    });

    if (!patchRes.ok) {
      const err = await patchRes.text();
      throw new Error(`Kunne ikke opdatere relationer/tags på #${id}: ${err}`);
    }

    return res.json({
      success: true,
      unlinkedCount: childIndices.length,
      message: `Renset #${id}: Fjernede ${childIndices.length} underordnede link(s) og ryddede alle tags.`
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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

// DELETE /api/workitem/:id
app.delete('/api/workitem/:id', async (req, res) => {
  const { org, project, pat } = req.body;
  const { id } = req.params;

  if (!org || !project || !pat || !id) {
    return res.status(400).json({ error: 'Organization, Project, PAT and ID are required.' });
  }

  try {
    await deleteWorkItemAdo({ org, project, pat, id });
    return res.json({ success: true, id, message: `Work item #${id} blev slettet.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/workitems/delete (Bulk delete)
app.post('/api/workitems/delete', async (req, res) => {
  const { org, project, pat, ids } = req.body;

  if (!org || !project || !pat || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Organization, Project, PAT and an array of IDs are required.' });
  }

  const deleted = [];
  const errors = [];

  for (const id of ids) {
    try {
      await deleteWorkItemAdo({ org, project, pat, id });
      deleted.push(id);
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }

  return res.json({
    success: errors.length === 0,
    deleted,
    errors
  });
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
