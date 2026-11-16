import { test, expect, type Page } from '@playwright/test';

/**
 * Browser tests for the React UI: create buckets, upload into bucket/folder and
 * into the base, filter, check download links and delete objects.
 */

const unique = (label: string) =>
  `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function createBucket(page: Page, name: string) {
  const input = page.getByPlaceholder('new-bucket');
  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
}

async function uploadFile(page: Page, name: string, content = 'hello from playwright') {
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(content),
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('In-memory backend')).toBeVisible();
});

test('shows the backend, the base folder and the upload destination', async ({ page }) => {
  await expect(page.getByText('base: in-process memory')).toBeVisible();
  await expect(page.getByRole('button', { name: 'base (main folder)' })).toBeVisible();
  await expect(page.getByText('base/filename', { exact: true })).toBeVisible();
  await expect(page.getByText('No objects here yet. Drop files above to store them in')).toBeVisible();
});

test('creates a bucket and uploads an object into it', async ({ page }) => {
  const bucket = unique('ui-bucket');
  await createBucket(page, bucket);

  await expect(page.getByText(`base/filename`)).toHaveCount(0);
  await expect(page.getByText(`${bucket}/filename`, { exact: true })).toBeVisible();

  await uploadFile(page, 'hello.txt');
  await expect(page.getByRole('link', { name: 'hello.txt' })).toBeVisible();
  await expect(page.getByText('1 object')).toBeVisible();
});

test('uploads into a nested folder inside a bucket', async ({ page }) => {
  const bucket = unique('ui-nested');
  await createBucket(page, bucket);

  await page
    .getByPlaceholder('destination folder, e.g. 2026/trips (optional)')
    .fill('2026/trips');
  await expect(page.getByText(`${bucket}/2026/trips/filename`, { exact: true })).toBeVisible();

  await uploadFile(page, 'cat.txt');
  await expect(page.getByRole('link', { name: '2026/trips/cat.txt' })).toBeVisible();
});

test('stores and deletes objects directly in the base folder', async ({ page }) => {
  await page.getByRole('button', { name: 'base (main folder)' }).click();
  await expect(page.getByText('base/filename', { exact: true })).toBeVisible();

  const name = `base-${Date.now()}.txt`;
  await uploadFile(page, name);
  const row = page.locator('tr').filter({ hasText: name });
  await expect(row).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});

test('exposes a download link for stored objects', async ({ page }) => {
  const bucket = unique('ui-download');
  await createBucket(page, bucket);
  await uploadFile(page, 'report.txt', 'download me');

  const row = page.locator('tr').filter({ hasText: 'report.txt' });
  const download = row.getByRole('link', { name: 'Download' });
  await expect(download).toHaveAttribute('href', /\/objects\/report\.txt\?download=1$/);

  // the key itself links to the raw object (no attachment header)
  await expect(row.getByRole('link', { name: 'report.txt' })).toHaveAttribute(
    'href',
    /\/objects\/report\.txt$/
  );

  const attachment = await page.request.get(
    `/api/buckets/${bucket}/objects/report.txt?download=1`
  );
  expect(attachment.status()).toBe(200);
  expect(await attachment.text()).toBe('download me');
});

test('filters objects by prefix', async ({ page }) => {
  const bucket = unique('ui-filter');
  await createBucket(page, bucket);

  const folder = page.getByPlaceholder('destination folder, e.g. 2026/trips (optional)');
  await folder.fill('docs');
  await uploadFile(page, 'a.txt');
  await folder.fill('images');
  await uploadFile(page, 'b.txt');

  await expect(page.getByRole('link', { name: 'docs/a.txt' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'images/b.txt' })).toBeVisible();

  await page.getByPlaceholder('filter by prefix, e.g. 2026/').fill('docs/');
  await expect(page.getByRole('link', { name: 'docs/a.txt' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'images/b.txt' })).toHaveCount(0);
});

test('rejects a duplicate bucket name with a toast', async ({ page }) => {
  const bucket = unique('ui-dup');
  await createBucket(page, bucket);

  await page.getByPlaceholder('new-bucket').fill(bucket);
  await page.getByPlaceholder('new-bucket').press('Enter');

  await expect(page.getByText('Could not create bucket')).toBeVisible();
  await expect(page.getByRole('button', { name: bucket, exact: true })).toHaveCount(1);
});

test('links the base folder and each object to Drive when the backend provides urls', async ({ page }) => {
  const folderUrl = 'https://drive.google.com/drive/folders/base123';
  const fileUrl = 'https://drive.google.com/file/d/file123/view';

  // Pretend to be the Drive backend: real server data plus the provider links.
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        mode: 'drive',
        base: 'Drive folder "bucket-base" (base123)',
        baseUrl: folderUrl,
      },
    });
  });

  await page.route('**/api/buckets/_root*', async (route) => {
    await route.fulfill({
      json: {
        bucket: '_root',
        objects: [
          {
            key: 'welcome.txt',
            size: 12,
            contentType: 'text/plain',
            etag: 'a'.repeat(32),
            lastModified: new Date().toISOString(),
            metadata: {},
            url: fileUrl,
          },
        ],
      },
    });
  });

  await page.goto('/');

  await expect(page.getByText('Drive backend')).toBeVisible();
  await expect(page.getByRole('link', { name: /base: Drive folder/ })).toHaveAttribute('href', folderUrl);
  await expect(page.getByRole('link', { name: 'Open in Drive' })).toHaveAttribute('href', fileUrl);
});
