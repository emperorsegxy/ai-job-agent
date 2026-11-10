import { execFile } from 'child_process';
import * as path from 'path';
import type { JobPosting } from '../../config/firebase';
import { NotificationService } from '../../services/notification-service';

// Maximum time (ms) to wait for all job board scrapes to complete
const SCRAPE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const SCRAPE_MAX_BUFFER_BYTES = 20 * 1024 * 1024;

interface ScrapedJob {
  id: string;
  title: string;
  company: string;
  location: string;
  workplace_type: string;
  job_url: string;
  description: string;
  site: string;
  date_posted?: string;
}

export interface JobspyRunOptions {
  /** Interpreter used to start the wrapper. Defaults to python3. */
  pythonBin?: string;
  /** Wrapper script. Defaults to jobspy_wrapper.py in the working directory. */
  scriptPath?: string;
  /** Extra environment for the child. Merged over process.env. */
  env?: NodeJS.ProcessEnv;
}

export function countryForLocation(primaryLoc: string): string {
  let countryArg = 'worldwide';
  const locLower = (primaryLoc || '').toLowerCase();
  if (locLower.includes('uk') || locLower.includes('united kingdom') || locLower.includes('london')) countryArg = 'uk';
  else if (locLower.includes('germany') || locLower.includes('berlin') || locLower.includes('munich')) countryArg = 'germany';
  else if (locLower.includes('netherlands') || locLower.includes('amsterdam')) countryArg = 'netherlands';
  else if (locLower.includes('canada') || locLower.includes('toronto')) countryArg = 'canada';
  else if (locLower.includes('nigeria') || locLower.includes('lagos')) countryArg = 'nigeria';
  else if (locLower.includes('south africa') || locLower.includes('cape town')) countryArg = 'south africa';
  else if (locLower.includes('singapore')) countryArg = 'singapore';
  else if (locLower.includes('india') || locLower.includes('bengaluru')) countryArg = 'india';
  else if (locLower.includes('united states') || locLower.includes('usa')) countryArg = 'usa';
  return countryArg;
}

/**
 * Argv for jobspy_wrapper.py. Role and location are always their own elements
 * and are never concatenated into a shell command.
 */
export function buildJobspyArgs(
  searchTerms: string | string[],
  locations: string | string[],
  limitPerSite: number = 10,
  hoursOld: number = 336,
): { args: string[]; country: string; primaryLoc: string } {
  const terms = Array.isArray(searchTerms) ? searchTerms : [searchTerms];
  const locs = Array.isArray(locations) ? locations : [locations];

  const primaryTerm = terms[0] || 'Software Engineer';
  const primaryLoc = locs[0] || '';
  const extraTerms = terms.slice(1);
  const extraLocs = locs.slice(1);
  const country = countryForLocation(primaryLoc);

  const args: string[] = ['--search', primaryTerm];
  if (primaryLoc) {
    args.push('--location', primaryLoc);
  }
  if (extraTerms.length > 0) {
    args.push('--searches', JSON.stringify(extraTerms));
  }
  if (extraLocs.length > 0) {
    args.push('--locations', JSON.stringify(extraLocs));
  }
  args.push(
    '--sites',
    'indeed,linkedin,zip_recruiter,glassdoor,google',
    '--limit',
    String(limitPerSite),
    '--hours',
    String(hoursOld || 336),
    '--country',
    country,
  );

  return { args, country, primaryLoc };
}

export class JobspyRunner {
  /**
   * Scrapes multiple job boards concurrently using python-jobspy.
   * Accepts multiple search terms and locations for broader coverage.
   * All scraping happens in the Python wrapper via ThreadPoolExecutor.
   * The child is started with execFile (no shell).
   */
  static async scrape(
    searchTerms: string | string[],
    locations: string | string[],
    limitPerSite: number = 10,
    hoursOld: number = 336, // 2 weeks
    options?: JobspyRunOptions,
  ): Promise<JobPosting[]> {
    const { args, country: countryArg, primaryLoc } = buildJobspyArgs(
      searchTerms,
      locations,
      limitPerSite,
      hoursOld,
    );
    const terms = Array.isArray(searchTerms) ? searchTerms : [searchTerms];
    const locs = Array.isArray(locations) ? locations : [locations];

    const pythonBin = options?.pythonBin ?? 'python3';
    const pythonScript = options?.scriptPath ?? path.resolve(process.cwd(), 'jobspy_wrapper.py');

    console.log(`[JobSpy] Launching multi-board scrape (Indeed, LinkedIn, ZipRecruiter, Glassdoor, Google) across ${terms.length} search term(s) and ${locs.length} location(s) (Region: ${countryArg}, Window: 2 weeks)...`);

    return new Promise((resolve) => {
      execFile(
        pythonBin,
        [pythonScript, ...args],
        {
          encoding: 'utf8',
          maxBuffer: SCRAPE_MAX_BUFFER_BYTES,
          timeout: SCRAPE_TIMEOUT_MS,
          shell: false,
          env: options?.env ? { ...process.env, ...options.env } : process.env,
        },
        (error, stdout, stderr) => {
          // Log progress output from the wrapper
          if (stderr) {
            stderr.split('\n').filter(Boolean).forEach(line => console.log(`[JobSpy] ${line}`));
          }

          if (error) {
            const isTimeout = error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
            const msg = isTimeout
              ? `Job board scrape timed out after ${SCRAPE_TIMEOUT_MS / 1000}s — check your network connection.`
              : `Job board scraper failed: ${error.message}`;
            console.warn(`[JobSpy] ${msg}`);
            NotificationService.send({
              type: 'INFO',
              title: isTimeout ? '⏱ Scrape Timeout' : '⚠️ Scraper Error',
              body: msg,
              timestamp: new Date().toISOString(),
            });
            resolve([]);
            return;
          }

          try {
            const parsed = JSON.parse(stdout);
            if (parsed && (parsed as { error?: string }).error) {
              const errMsg = `Job board API error: ${(parsed as { error: string }).error}`;
              console.warn(`[JobSpy] ${errMsg}`);
              NotificationService.send({
                type: 'INFO',
                title: '⚠️ Scraper API Error',
                body: errMsg,
                timestamp: new Date().toISOString(),
              });
              resolve([]);
              return;
            }

            const rawJobs: ScrapedJob[] = Array.isArray(parsed) ? parsed : [];
            const postings: JobPosting[] = rawJobs
              .filter(job => job.job_url && job.title && job.company)
              .map((job) => {
                const url = job.job_url.trim();
                const siteName = (job.site || '').toLowerCase();
                const boardType = url.includes('lever.co')
                  ? 'lever'
                  : url.includes('greenhouse.io')
                  ? 'greenhouse'
                  : ['indeed', 'linkedin', 'zip_recruiter', 'glassdoor', 'google'].includes(siteName)
                  ? siteName
                  : 'custom';

                const companyKey = job.company.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 20);
                const titleKey = job.title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 25);
                // Clean normalized URL to generate consistent hash
                const cleanUrl = url.toLowerCase().split('?')[0].split('#')[0].replace(/\/+$/, '');
                let hash = 0;
                for (let i = 0; i < cleanUrl.length; i++) {
                  hash = ((hash << 5) - hash) + cleanUrl.charCodeAt(i);
                  hash |= 0;
                }
                const urlHash = Math.abs(hash).toString(36);

                return {
                  jobId: `${boardType}_${companyKey}_${titleKey}_${urlHash}`,
                  title: job.title.trim(),
                  company: job.company.trim(),
                  location: job.location || primaryLoc || 'Remote',
                  workplaceType: job.workplace_type || 'Full-time',
                  boardType: (boardType === 'zip_recruiter' ? 'custom' : boardType) as JobPosting['boardType'],
                  applyUrl: url,
                  postedAt: job.date_posted ? new Date(job.date_posted).toISOString() : new Date().toISOString(),
                  discoveredAt: new Date().toISOString(),
                  status: 'NEW',
                };
              });

            console.log(`[JobSpy] Parsed ${postings.length} unique live job postings across Indeed, LinkedIn, ZipRecruiter, Glassdoor, and Google.`);
            resolve(postings);
          } catch (parseError) {
            console.warn(`[JobSpy] Failed to parse output: ${parseError}. Returning empty list.`);
            resolve([]);
          }
        }
      );
    });
  }
}
