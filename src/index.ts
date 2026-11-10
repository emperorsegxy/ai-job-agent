import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { dbService } from './config/firebase.js';
import { applyProfileUpdate } from './modules/cv-parser/profile-update.js';
import { PipelineOrchestrator } from './jobs/cron-scheduler.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static assets for the Dashboard UI
const publicDir = path.resolve(process.cwd(), 'src/public');
app.use(express.static(publicDir));

// Serve screenshots and other uploaded files locally
const uploadsDir = path.resolve(process.cwd(), 'storage/temp/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/static', express.static(uploadsDir));

// --- API Endpoints ---

// 1. Get Candidate Profile
app.get('/api/profile', async (req, res) => {
  try {
    const profile = await dbService.getProfile();
    if (!profile) {
      return res.status(404).json({ error: 'No profile found. Please upload/create one.' });
    }
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Update Profile Data Directly
app.post('/api/profile/update', async (req, res) => {
  try {
    const result = await applyProfileUpdate(req.body, dbService);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ message: 'Profile updated successfully.', profile: result.profile });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. List Discovered Jobs
app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await dbService.listJobs();
    // Sort by discovered date descending
    jobs.sort((a, b) => new Date(b.discoveredAt).getTime() - new Date(a.discoveredAt).getTime());
    res.json(jobs);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. List Application Records (Audit trail)
app.get('/api/applications', async (req, res) => {
  try {
    const apps = await dbService.listApplications();
    apps.sort((a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime());
    res.json(apps);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Trigger Pipeline Run Manually
app.post('/api/pipeline/run', async (req, res) => {
  try {
    const dryRun = req.body.dryRun !== false; // Defaults to true
    
    // Run the pipeline asynchronously so the API returns immediately
    console.log(`Triggering pipeline manually. Dry-run mode: ${dryRun}`);
    PipelineOrchestrator.runFullPipeline(dryRun)
      .then(() => console.log('Manual pipeline execution finished.'))
      .catch((err) => console.error('Error running manual pipeline:', err));

    res.json({ message: 'Pipeline run initiated in the background.', dryRun });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend routing for SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`AI Job Application Agent Monolith Engine online.`);
  console.log(`Dashboard Server: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
