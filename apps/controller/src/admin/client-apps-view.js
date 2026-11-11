/**
 * Client apps: publish Android builds and read their crash reports.
 *
 * The operator workflow this exists for: build an APK (one per ABI), upload it
 * here with a version and an increasing build number, publish it, and every
 * installed app offers the update the next time it opens. Nothing is typed into
 * the server's environment or copied into the container by hand.
 *
 * Uploading and publishing are separate actions on purpose. A release with one
 * of three ABIs uploaded is a draft until the operator says it is ready, so a
 * slow upload cannot become the update offered to every user.
 */
import { h, mount, bytes, date, ago, badge, toast, confirmDialog, copyText } from './dom.js';

/** ABIs the controller accepts, matching services/client-apps.ts. */
const ABIS = ['universal', 'arm64-v8a', 'armeabi-v7a', 'x86_64'];

export async function clientAppsView(api) {
  const host = h('div', {});
  let data = null;

  async function load() {
    data = await api.get('/api/v1/admin/client-apps/android/releases');
    const crashData = await api
      .get('/api/v1/admin/client-apps/android/crashes?limit=50')
      .catch(() => ({ crashes: [] }));
    draw(crashData.crashes ?? []);
  }

  async function changeStatus(buildNumber, status) {
    try {
      await api.post(`/api/v1/admin/client-apps/android/releases/${buildNumber}/status`, { status });
      toast(status === 'published' ? `Build ${buildNumber} is now offered to users` : `Build ${buildNumber} ${status}`);
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function removeRelease(buildNumber) {
    const ok = await confirmDialog({
      title: `Delete build ${buildNumber}?`,
      body: h('div', {},
        h('p', {}, 'The uploaded APKs and their release row are removed.'),
        h('p', { class: 'muted small' }, 'Apps already running this build keep working; it just stops being offered.'),
      ),
      confirmLabel: 'Delete build',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/admin/client-apps/android/releases/${buildNumber}`);
      toast('Build deleted');
      await load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function uploadPanel() {
    const version = h('input', { type: 'text', placeholder: '0.2.0', value: data?.releases?.[0]?.version ?? '' });
    const build = h('input', {
      type: 'number',
      min: '1',
      placeholder: 'next build number',
      value: String((data?.activeBuildNumber ?? 0) + 1),
    });
    const abi = h('select', {}, ...ABIS.map((value) => h('option', { value }, value)));
    const notes = h('textarea', { rows: '3', placeholder: 'What changed in this build (shown in the update prompt)' });
    const file = h('input', { type: 'file', accept: '.apk,application/vnd.android.package-archive' });
    const publishAfter = h('input', { type: 'checkbox', checked: true });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Upload APK');
    const hint = h('p', { class: 'muted small' });

    const form = h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        const apk = file.files?.[0];
        if (!apk) {
          toast('Choose an APK file first', 'err');
          return;
        }
        if (!/\.apk$/i.test(apk.name)) {
          toast('That file is not an APK', 'err');
          return;
        }
        const buildNumber = Number.parseInt(build.value, 10);
        if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) {
          toast('Build number must be a positive whole number', 'err');
          return;
        }
        if (!version.value.trim()) {
          toast('A version name is required', 'err');
          return;
        }

        submit.disabled = true;
        submit.textContent = `Uploading ${apk.name}…`;
        hint.textContent = `${bytes(apk.size)} · ${abi.value}`;
        try {
          const query = new URLSearchParams({
            version: version.value.trim(),
            notes: notes.value.trim(),
            abi: abi.value,
          });
          await api.uploadFile(
            `/api/v1/admin/client-apps/android/releases/${buildNumber}/artifacts?${query.toString()}`,
            apk,
          );
          if (publishAfter.checked) {
            await api.post(`/api/v1/admin/client-apps/android/releases/${buildNumber}/status`, { status: 'published' });
            toast(`Build ${buildNumber} uploaded and published`);
          } else {
            toast(`Build ${buildNumber} uploaded as a draft`);
          }
          await load();
        } catch (err) {
          toast(err.message || 'Upload failed', 'err');
          submit.disabled = false;
          submit.textContent = 'Upload APK';
          hint.textContent = '';
        }
      },
    },
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', {}, 'Version name'), version),
        h('label', { class: 'field' }, h('span', {}, 'Build number'), build),
        h('label', { class: 'field' }, h('span', {}, 'CPU architecture (ABI)'), abi),
        h('label', { class: 'field' }, h('span', {}, 'APK file'), file),
        h('label', { class: 'field', style: 'grid-column: 1 / -1' }, h('span', {}, 'Release notes'), notes),
        h('div', { class: 'inline' },
          publishAfter,
          h('span', { class: 'muted small' }, 'Publish immediately (otherwise it is stored as a draft)'),
        ),
        h('div', { class: 'actions' }, submit, hint),
      ),
    );

    return h('div', { class: 'panel' },
      h('header', {},
        h('h3', {}, 'Upload a build'),
        h('span', { class: 'muted small' }, 'One APK per ABI; repeat for each architecture you built'),
      ),
      h('div', { class: 'body' }, form),
    );
  }

  function draw(crashes) {
    const releases = data?.releases ?? [];
    const storedApks = releases.reduce((total, release) => total + (release.artifacts?.length ?? 0), 0);
    const active = releases.find((release) => release.buildNumber === data?.activeBuildNumber) ?? null;

    mount(host,
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, 'Client apps'),
          h('p', {}, 'Publish Android builds to installed apps, and read the crashes they report.'),
        ),
        h('div', { class: 'row' },
          h('span', { class: data?.activeBuildNumber ? 'badge active' : 'badge offline' },
            data?.activeBuildNumber ? `serving build ${data.activeBuildNumber}` : 'no build published'),
          h('button', { class: 'btn sm', onClick: () => load() }, 'Refresh'),
        ),
      ),

      data?.activeSource === 'environment'
        ? h('div', { class: 'panel' },
            h('div', { class: 'notice' },
              'Clients are currently served by the ',
              h('code', {}, 'CLIENT_ANDROID_*'),
              ' environment values. Uploading and publishing a build here takes precedence from then on.',
            ),
          )
        : null,

      h('div', { class: 'stats' },
        h('div', { class: 'stat' },
          h('div', { class: 'label' }, 'Published build'),
          h('div', { class: 'value' }, String(data?.activeBuildNumber ?? '—')),
          h('div', { class: 'hint' }, active ? `v${active.version}` : 'upload a build to begin'),
        ),
        h('div', { class: 'stat' },
          h('div', { class: 'label' }, 'Stored APKs'),
          h('div', { class: 'value' }, String(storedApks)),
          h('div', { class: 'hint' }, `${releases.length} build(s) known`),
        ),
        h('div', { class: 'stat' },
          h('div', { class: 'label' }, 'Crash reports'),
          h('div', { class: 'value' }, String(crashes.length)),
          h('div', { class: 'hint' }, crashes.length ? 'most recent shown below' : 'none reported'),
        ),
      ),

      uploadPanel(),

      h('div', { class: 'panel' },
        h('header', {},
          h('h3', {}, 'Published releases'),
          h('span', { class: 'muted small' }, 'The highest published build is what apps are offered'),
        ),
        h('div', { class: 'body' },
          h('div', { class: 'row' },
            h('code', {}, '/api/v1/app/android'),
            h('button', {
              class: 'btn sm',
              onClick: () => copyText(`${location.origin}/api/v1/app/android`),
            }, 'Copy update feed URL'),
          ),
        ),
        h('div', { class: 'table-wrap' },
          releases.length === 0
            ? h('div', { class: 'empty' }, 'No builds uploaded yet.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'Build'),
                h('th', {}, 'Version'),
                h('th', {}, 'APKs'),
                h('th', {}, 'Total size'),
                h('th', {}, 'Status'),
                h('th', {}, 'Uploaded'),
                h('th', { class: 'right' }, 'Actions'),
              )),
              h('tbody', {}, ...releases.map((release) => {
                const artifacts = release.artifacts ?? [];
                const total = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
                const isActive = release.buildNumber === data?.activeBuildNumber;
                return h('tr', {},
                  h('td', {},
                    h('div', { class: 'mono' }, String(release.buildNumber)),
                    isActive ? h('span', { class: 'muted small' }, 'serving') : null,
                  ),
                  h('td', {},
                    h('div', {}, release.version),
                    release.notes ? h('span', { class: 'muted small' }, release.notes.slice(0, 80)) : null,
                  ),
                  h('td', { class: 'small' },
                    artifacts.length === 0
                      ? h('span', { class: 'muted' }, 'none')
                      : h('div', { class: 'stack', style: 'gap:4px' },
                          ...artifacts.map((artifact) =>
                            h('div', { title: artifact.sha256 },
                              h('span', { class: 'mono' }, artifact.abi),
                              ' · ',
                              bytes(artifact.sizeBytes),
                            ),
                          ),
                        ),
                  ),
                  h('td', { class: 'small' }, bytes(total)),
                  h('td', {}, badge(release.status)),
                  h('td', { class: 'small muted' }, date(release.createdAt)),
                  h('td', { class: 'actions' },
                    release.status !== 'published'
                      ? h('button', {
                          class: 'btn sm primary',
                          onClick: () => changeStatus(release.buildNumber, 'published'),
                        }, 'Publish')
                      : h('button', {
                          class: 'btn sm',
                          onClick: () => changeStatus(release.buildNumber, 'revoked'),
                        }, 'Withdraw'),
                    ' ',
                    h('button', {
                      class: 'btn sm danger',
                      onClick: () => removeRelease(release.buildNumber),
                    }, 'Delete'),
                  ),
                );
              })),
            ),
        ),
      ),

      h('div', { class: 'panel' },
        h('header', {},
          h('h3', {}, 'Crash reports'),
          h('span', { class: 'muted small' }, 'Sent by the app when it hits an uncaught error'),
        ),
        h('div', { class: 'table-wrap' },
          crashes.length === 0
            ? h('div', { class: 'empty' }, 'No crashes reported.')
            : h('table', {},
              h('thead', {}, h('tr', {},
                h('th', {}, 'When'),
                h('th', {}, 'Build'),
                h('th', {}, 'Device'),
                h('th', {}, 'Message'),
              )),
              h('tbody', {}, ...crashes.map((crash) => h('tr', {},
                h('td', { class: 'small muted', title: date(crash.createdAt) }, ago(crash.createdAt)),
                h('td', { class: 'small' },
                  h('div', { class: 'mono' }, crash.buildNumber ? `#${crash.buildNumber}` : '—'),
                  h('span', { class: 'muted small' }, [crash.appVersion, crash.abi].filter(Boolean).join(' · ')),
                ),
                h('td', { class: 'small' },
                  h('div', {}, crash.device ?? '—'),
                  h('span', { class: 'muted small' }, crash.osVersion ?? ''),
                ),
                h('td', { class: 'small' },
                  h('div', {}, crash.message),
                  crash.stack
                    ? h('details', {},
                        h('summary', { class: 'muted small' }, 'Stack trace'),
                        h('pre', { class: 'copy', style: 'max-height:180px;overflow:auto;margin-top:8px' }, crash.stack),
                      )
                    : null,
                ),
              ))),
            ),
        ),
      ),
    );
  }

  await load();
  return host;
}
