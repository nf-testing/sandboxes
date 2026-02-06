/**
 * Benchmark sandbox cold start latency.
 *
 * Pattern: create service (0 instances) → attach volume → scale to 1
 *          → retry exec until it works (that's our readiness signal)
 *
 * Usage:
 *   NORTHFLANK_API_TOKEN=xxx npx tsx admin/bench_sandbox.ts [plan] [image-type]
 *
 * Default plan: nf-compute-200
 * image-type: "build" (default) or "external:imagePath" (e.g., "external:buildpack-deps:22.04-curl")
 */

import { ApiClient, ApiClientFileContextProvider } from '@northflank/js-client';

const HARD_TIMEOUT_MS = 60_000; // 1 minute — fail if not online
const EXEC_RETRY_DELAY_MS = 50;
const CONTAINER_RUNNING_TIMEOUT_MS = 30_000; // 30 seconds to wait for container to be running
const CONTAINER_POLL_DELAY_MS = 100;

interface StepTiming {
  step: string;
  durationMs: number;
  error?: string;
}

interface ExecResult {
  startedAt?: Date;
  completedAt?: Date;
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

interface TimestampLog {
  section: string;
  subsection: string;
  timestamp: Date;
}

function calculateStats(values: number[]): { avg: number; std: number; min: number; max: number } {
  if (values.length === 0) {
    return { avg: 0, std: 0, min: 0, max: 0 };
  }

  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
  const std = Math.sqrt(variance);
  const min = Math.min(...values);
  const max = Math.max(...values);

  return { avg, std, min, max };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryExec(
  api: ApiClient,
  projectId: string,
  serviceId: string,
  command: string[]
): Promise<ExecResult> {
  const startedAt = new Date();
  try {
    const commandRes = await api.exec.execServiceCommand(
      { projectId, serviceId },
      {
        command,
        shell: 'none',
      }
    );

    return {
      ok: commandRes.commandResult.status === 'Success',
      startedAt,
      completedAt: new Date(),
      stderr: commandRes.stdErr,
      stdout: commandRes.stdOut,
      error: commandRes.commandResult.message,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(msg);
    return { ok: false, stdout: '', stderr: '', error: msg, startedAt, completedAt: new Date() };
  }
}

async function cleanupCluster(api: ApiClient, projectId: string) {
  console.log('Cleaning up existing resources...');

  const svcRes = await api.list.services({ parameters: { projectId } });
  const services = svcRes.data?.services ?? [];
  for (const svc of services) {
    if (svc.id.startsWith('bench-')) {
      console.log(`  Deleting service: ${svc.id}`);
      await api.delete.service({ parameters: { projectId, serviceId: svc.id } }).catch(() => {});
    }
  }

  if (services.length > 0) {
    await sleep(3000);
  }
  let svcRes2 = await api.list.services({ parameters: { projectId } });
  let services2 = svcRes2.data?.services ?? [];
  let servicePresent = services2.some((svc) => svc.id.startsWith('bench-'));
  while (servicePresent) {
    svcRes2 = await api.list.services({ parameters: { projectId } });
    services2 = svcRes2.data?.services ?? [];
    const present = services2.filter((svc) => svc.id.startsWith('bench-'));
    servicePresent = present.length > 0;
    console.log('service still present', present.map((s) => s.appId).join(', '));
    await sleep(100);
  }

  console.log('Cleanup done.\n');
}

async function runBenchmark(
  api: ApiClient,
  projectId: string,
  plan: string,
  imageType: { type: 'build'; buildId: string } | { type: 'external'; imagePath: string }
): Promise<{ timings: StepTiming[]; success: boolean; execCompletedTime?: number }> {
  const planShort = plan.replace('nf-compute-', 'c');
  const ts = Date.now().toString(36);
  const serviceId = `bench-${planShort}-${ts}`;
  const volumeId = `bvol-${planShort}-${ts}`;
  const timings: StepTiming[] = [];
  const timestampLogs: TimestampLog[] = [];

  function recordStep(step: string, startMs: number, error?: string): StepTiming {
    const end = Date.now();
    const timing = { step, durationMs: end - startMs, error };
    timings.push(timing);
    const status = error
      ? `FAILED: ${error}`
      : `${timing.durationMs}ms (${new Date(startMs).toISOString()}->${new Date(end).toISOString()})`;
    console.log(`  ${step.padEnd(22)} ${status}`);
    return timing;
  }

  async function cleanup() {
    await api.delete.service({ parameters: { projectId, serviceId } }).catch(() => {});
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = await api.delete
        .volume({ parameters: { projectId, volumeId } })
        .catch(() => ({ error: { status: 500 } }));
      if (!r.error || r.error.status !== 409) {
        break;
      }
      await sleep(1000);
    }
  }

  // Step 1: Create service with 1 instance.
  let t0 = Date.now();
  const apiRequestSent = new Date();
  timestampLogs.push({
    section: 'Service Creation',
    subsection: 'API request sent',
    timestamp: apiRequestSent,
  });

  // Build deployment config based on image type
  const deploymentConfig: any = {
    instances: 1,
    docker: {
      configType: 'customCommand',
      customCommand: 'sleep infinity',
    },
  };

  if (imageType.type === 'build') {
    deploymentConfig.internal = {
      id: imageType.buildId,
      buildSHA: 'latest',
      branch: 'main',
    };
  } else {
    deploymentConfig.external = {
      imagePath: imageType.imagePath,
    };
  }

  const svcRes = await api.create.service.deployment({
    parameters: { projectId },
    data: {
      name: serviceId,
      billing: { deploymentPlan: plan },
      deployment: deploymentConfig,
      runtimeEnvironment: {},
    },
  });

  const apiRequestReturned = new Date();
  timestampLogs.push({
    section: 'Service Creation',
    subsection: 'API request returned ' + serviceId,
    timestamp: apiRequestReturned,
  });

  if (svcRes.error) {
    recordStep('Create service', t0, JSON.stringify(svcRes.error));
    return { timings, success: false };
  }

  recordStep('Create service', t0);

  // Step 2: Retry exec until it works — that's our readiness signal.
  t0 = Date.now();
  const hardDeadline = Date.now() + HARD_TIMEOUT_MS;
  let execOk = false;
  let lastExecError = '';
  let attempts = 0;
  let successfulExecResult: ExecResult | null = null;
  let firstAttemptStarted: Date | null = null;

  const api2 = new ApiClient(new ApiClientFileContextProvider());

  while (Date.now() < hardDeadline) {
    attempts++;
    const result = await tryExec(api2, projectId, serviceId, [
      'bash',
      '-c',
      'date +"%Y-%m-%dT%H:%M:%S.%3N%z"',
    ]);
    console.log(`${new Date().toISOString()}: ${result.stdout}`);

    if (attempts === 1 && result.startedAt) {
      firstAttemptStarted = result.startedAt;
      timestampLogs.push({
        section: 'Exec',
        subsection: 'Initial attempt started',
        timestamp: result.startedAt,
      });
    }

    if (result.ok) {
      successfulExecResult = result;

      // Add successful attempt started timestamp
      if (result.startedAt) {
        timestampLogs.push({
          section: 'Exec',
          subsection: 'Successful attempt started',
          timestamp: result.startedAt,
        });
      }

      // Parse the command output timestamp (when the actual command ran)
      if (result.stdout) {
        const commandTimestamp = result.stdout.trim();
        try {
          const commandRanAt = new Date(commandTimestamp);
          if (!isNaN(commandRanAt.getTime())) {
            timestampLogs.push({
              section: 'Exec',
              subsection: 'Command executed',
              timestamp: commandRanAt,
            });
          }
        } catch (e) {
          console.log(result.stdout);
          // If parsing fails, skip this timestamp
        }
      }

      // Add exec completion timestamp
      if (result.completedAt) {
        timestampLogs.push({
          section: 'Exec',
          subsection: 'Exec completed',
          timestamp: result.completedAt,
        });
      }

      execOk = true;
      break;
    }

    lastExecError = result.error ?? 'no output';

    if (Date.now() < hardDeadline) {
      await sleep(EXEC_RETRY_DELAY_MS);
    }
  }

  if (!execOk) {
    recordStep(
      'Exec readiness',
      t0,
      `${attempts} attempts in ${HARD_TIMEOUT_MS}ms — last: ${lastExecError}`
    );
    await cleanup();
    return { timings, success: false };
  }

  recordStep('Exec readiness', t0);
  console.log(`    (${attempts} exec attempt(s))`);

  // Calculate total time up to exec completion (before container fetch)
  const execCompletedTime = Date.now();

  // Step 3: Fetch container timestamps (after exec completes) and retry until status is TASK_RUNNING
  t0 = Date.now();
  const containerDeadline = Date.now() + CONTAINER_RUNNING_TIMEOUT_MS;
  let containerRunning = false;

  console.log('  Fetching container timestamps...');

  while (Date.now() < containerDeadline) {
    try {
      const containers = await api.get.service.containers({
        parameters: { projectId, serviceId },
      });

      if (containers.data.containers && containers.data.containers.length > 0) {
        const container = containers.data.containers[0];

        if (container.status === 'TASK_RUNNING') {
          // Record both timestamps once we confirm TASK_RUNNING status
          timestampLogs.push({
            section: 'Container Startup',
            subsection: 'Container created',
            timestamp: new Date(container.createdAt * 1000),
          });
          timestampLogs.push({
            section: 'Container Startup',
            subsection: 'Container TASK_RUNNING',
            timestamp: new Date(container.updatedAt * 1000),
          });
          containerRunning = true;
          break;
        }
      }
    } catch (err) {
      console.log(err.message);
      // Ignore errors and keep retrying
    }

    if (Date.now() < containerDeadline) {
      await sleep(CONTAINER_POLL_DELAY_MS);
    }
  }

  if (!containerRunning) {
    recordStep('Fetch container info', t0, 'Container did not reach TASK_RUNNING within timeout');
    // Don't fail the benchmark, just log the issue
    console.log('    Warning: Could not get accurate container timestamps');
  } else {
    recordStep('Fetch container info', t0);
  }

  console.log('\n=== TIMELINE ===');
  const sortedLogs = timestampLogs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Group logs by section and calculate section durations
  const sectionGroups = new Map<string, TimestampLog[]>();
  for (const log of sortedLogs) {
    if (!sectionGroups.has(log.section)) {
      sectionGroups.set(log.section, []);
    }
    sectionGroups.get(log.section)!.push(log);
  }

  // Pre-calculate durations for all sections
  const sectionDurations = new Map<string, number>();
  for (const [section, logs] of sectionGroups) {
    // For Exec section, calculate duration from "Successful attempt started" onwards
    let sectionStart: number;
    if (section === 'Exec') {
      const successfulAttempt = logs.find((l) => l.subsection === 'Successful attempt started');
      sectionStart = successfulAttempt
        ? successfulAttempt.timestamp.getTime()
        : logs[0].timestamp.getTime();
    } else {
      sectionStart = logs[0].timestamp.getTime();
    }

    const sectionEnd = logs[logs.length - 1].timestamp.getTime();
    const sectionDuration = sectionEnd - sectionStart;
    sectionDurations.set(section, sectionDuration);
  }

  let currentSection = '';
  for (const log of sortedLogs) {
    if (log.section !== currentSection) {
      currentSection = log.section;
      const duration = sectionDurations.get(currentSection) ?? 0;
      console.log(`\n[${log.section}] (${duration}ms)`);
    }
    console.log(`  ${log.subsection.padEnd(30)} ${log.timestamp.toISOString()}`);
  }

  // Calculate and print total time
  if (sortedLogs.length >= 2) {
    const firstTimestamp = sortedLogs[0].timestamp;
    const lastTimestamp = sortedLogs[sortedLogs.length - 1].timestamp;
    const totalTimeMs = lastTimestamp.getTime() - firstTimestamp.getTime();
    console.log(`\nTotal time (first to last event): ${totalTimeMs}ms`);

    // Calculate time without container fetch
    const timeWithoutContainerFetch = execCompletedTime - firstTimestamp.getTime();
    console.log(`Total time (without container fetch): ${timeWithoutContainerFetch}ms`);
  }

  // Step 4: Delete service.
  t0 = Date.now();
  // await api.delete.service({ parameters: { projectId, serviceId } }).catch(() => {});
  recordStep('Delete service', t0);

  return { timings, success: true, execCompletedTime };
}

interface BenchmarkStats {
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  execCompletedTime: {
    avg: number;
    std: number;
    min: number;
    max: number;
    values: number[];
  };
  stepStats: Map<
    string,
    {
      avg: number;
      std: number;
      min: number;
      max: number;
      values: number[];
    }
  >;
}

async function runBenchmarkMultiple(
  api: ApiClient,
  projectId: string,
  plan: string,
  imageType: { type: 'build'; buildId: string } | { type: 'external'; imagePath: string },
  iterations: number = 20
): Promise<BenchmarkStats> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Starting benchmark suite: ${iterations} iterations`);
  console.log(`Plan: ${plan}`);
  console.log(`Image Type: ${imageType.type}`);
  console.log(`${'='.repeat(80)}\n`);

  const allResults: Array<{
    timings: StepTiming[];
    success: boolean;
    execCompletedTime?: number;
  }> = [];

  // Run benchmarks
  for (let i = 0; i < iterations; i++) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`Run ${i + 1}/${iterations}`);
    console.log(`${'─'.repeat(80)}`);

    try {
      const result = await runBenchmark(api, projectId, plan, imageType);
      allResults.push(result);

      // Brief summary after each run
      if (result.success && result.execCompletedTime) {
        console.log(`✓ Run ${i + 1} completed successfully in ${result.execCompletedTime}ms`);
      } else {
        console.log(`✗ Run ${i + 1} failed`);
      }

      // Small delay between runs to avoid overwhelming the API
      if (i < iterations - 1) {
        await sleep(2000);
      }
    } catch (error) {
      console.error(`✗ Run ${i + 1} threw an error:`, error);
      allResults.push({ timings: [], success: false });
    }
  }

  // Calculate statistics
  const successfulRuns = allResults.filter((r) => r.success);
  const failedRuns = allResults.filter((r) => !r.success);

  // Collect exec completion times
  const execTimes = successfulRuns
    .filter((r) => r.execCompletedTime !== undefined)
    .map((r) => r.execCompletedTime!);

  // Collect step timings by step name
  const stepTimingsMap = new Map<string, number[]>();
  for (const result of successfulRuns) {
    for (const timing of result.timings) {
      if (!timing.error) {
        if (!stepTimingsMap.has(timing.step)) {
          stepTimingsMap.set(timing.step, []);
        }
        stepTimingsMap.get(timing.step)!.push(timing.durationMs);
      }
    }
  }

  // Calculate stats for each step
  const stepStats = new Map<
    string,
    {
      avg: number;
      std: number;
      min: number;
      max: number;
      values: number[];
    }
  >();

  for (const [step, values] of stepTimingsMap) {
    const stats = calculateStats(values);
    stepStats.set(step, { ...stats, values });
  }

  const execStats = calculateStats(execTimes);

  // Print results
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('BENCHMARK RESULTS');
  console.log(`${'='.repeat(80)}\n`);

  console.log(`Total Runs:      ${allResults.length}`);
  console.log(
    `Successful:      ${successfulRuns.length} (${((successfulRuns.length / allResults.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `Failed:          ${failedRuns.length} (${((failedRuns.length / allResults.length) * 100).toFixed(1)}%)`
  );

  if (execTimes.length > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log('EXEC COMPLETION TIME (ms)');
    console.log(`${'─'.repeat(80)}`);
    console.log(`Average:         ${execStats.avg.toFixed(2)}ms`);
    console.log(`Std Dev:         ${execStats.std.toFixed(2)}ms`);
    console.log(`Min:             ${execStats.min.toFixed(2)}ms`);
    console.log(`Max:             ${execStats.max.toFixed(2)}ms`);
  }

  if (stepStats.size > 0) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log('STEP TIMINGS (ms)');
    console.log(`${'─'.repeat(80)}`);

    for (const [step, stats] of stepStats) {
      console.log(`\n${step}:`);
      console.log(`  Average:       ${stats.avg.toFixed(2)}ms`);
      console.log(`  Std Dev:       ${stats.std.toFixed(2)}ms`);
      console.log(`  Min:           ${stats.min.toFixed(2)}ms`);
      console.log(`  Max:           ${stats.max.toFixed(2)}ms`);
      console.log(`  Samples:       ${stats.values.length}`);
    }
  }

  console.log(`\n${'='.repeat(80)}\n`);

  return {
    totalRuns: allResults.length,
    successfulRuns: successfulRuns.length,
    failedRuns: failedRuns.length,
    execCompletedTime: {
      ...execStats,
      values: execTimes,
    },
    stepStats,
  };
}

async function main() {
  const projectId = process.env.NORTHFLANK_PROJECT_ID ?? 'dust-sandbox-dev';
  const plan = process.argv[2] ?? 'nf-compute-200';

  const api = new ApiClient(new ApiClientFileContextProvider());

  console.log(`Plan: ${plan}`);
  console.log(`Readiness: retry exec until success (hard timeout: ${HARD_TIMEOUT_MS}ms)`);
  console.log(`Pattern: create(1) → exec → fetch container timestamps\n`);

  await cleanupCluster(api, projectId);

  // Use build ID from environment or default
  const buildId = process.env.NORTHFLANK_BUILD_ID ?? 'internal-build';
  const imageType = { buildId, type: 'build' };

  console.log(`--- Benchmark: ${plan} ---`);
  await runBenchmarkMultiple(api, projectId, plan, imageType);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
