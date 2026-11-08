import { A, Container, HeaderH3, Li, MainHeader, Space, Text, Ul } from 'jbx';

import { BASE_PATH } from '../../lib/constants.js';

const TITLE = 'Support | Star Trails for iPhone and iPad';
const DESCRIPTION =
  'Help and contact for the Star Trails app for iPhone and iPad: requirements, supported media, exports, and fixes for common problems.';
const CANONICAL = 'https://javier.xyz/startrails/support';
const THUMBNAIL = 'https://javier.xyz/startrails/javier-xyz-startrails.jpg';
const SUPPORT_MAIL =
  'mailto:hi@javier.xyz?subject=Star%20Trails%20app%20support';

export const metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: CANONICAL,
    images: [{ url: THUMBNAIL, width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [THUMBNAIL],
  },
};

export default function SupportPage() {
  return (
    <Container as="main">
      <MainHeader>star-trails support</MainHeader>
      <Space h={1} />
      <Text>
        Help for the Star Trails app for iPhone and iPad. It stacks photos or a
        video into one star trail image, all on your device.
      </Text>

      <Space h={2} />

      <HeaderH3>Contact</HeaderH3>
      <Space h={0.5} />
      <Text>
        Email <A href={SUPPORT_MAIL}>hi@javier.xyz</A> with questions, problems
        or ideas. It helps to include your device model, its iOS or iPadOS
        version, and what you were trying to import or export.
      </Text>

      <Space h={2} />

      <HeaderH3>Requirements</HeaderH3>
      <Space h={0.5} />
      <Text>An iPhone or iPad running iOS 26 or iPadOS 26, or later.</Text>

      <Space h={2} />

      <HeaderH3>What it works with</HeaderH3>
      <Space h={0.5} />
      <Ul>
        <Li>
          <strong>Input:</strong> photos or a video, opened from Photos or
          Files. Videos are sampled to at most 600 frames.
        </Li>
        <Li>
          <strong>Controls:</strong> <strong>Range</strong> picks which frames
          are stacked. <strong>Fade</strong> sets how the trails fade out.
        </Li>
        <Li>
          <strong>Export:</strong> a JPEG, a video or a Live Photo.
        </Li>
      </Ul>
      <Space h={1} />
      <Text>
        JPEG and Live Photo exports can keep the metadata of the first selected
        frame, including its GPS location. See the{' '}
        <A href={`${BASE_PATH}/privacy`}>privacy policy</A> for how to share
        without it.
      </Text>

      <Space h={2} />

      <HeaderH3>Saving to Photos doesn&apos;t work</HeaderH3>
      <Space h={0.5} />
      <Text>
        The app needs permission to add photos before it can save an export. If
        you chose <strong>Don&apos;t Allow</strong>, you can turn it back on:
      </Text>
      <Space h={0.5} />
      <Ul>
        <Li>Open the Settings app.</Li>
        <Li>Go to Apps › Star Trails › Photos.</Li>
        <Li>
          Choose <strong>Add Photos Only</strong>.
        </Li>
      </Ul>
      <Space h={1} />
      <Text>
        This only lets the app add new items. It can&apos;t see or change your
        library. Opening photos doesn&apos;t need this permission, because you
        pick them yourself.
      </Text>

      <Space h={2} />

      <HeaderH3>Running out of storage</HeaderH3>
      <Space h={0.5} />
      <Text>
        While you work, the app keeps temporary copies of your imports, the
        frames it samples from videos, and your exports. Many full-size photos
        or a long video can take a lot of space.
      </Text>
      <Space h={0.5} />
      <Ul>
        <Li>
          Check your free space in Settings › General › iPhone Storage (or iPad
          Storage), and free up some if it&apos;s low.
        </Li>
        <Li>Import fewer photos, or a shorter video.</Li>
        <Li>
          With iCloud Photos set to Optimize Storage, full-size originals are
          downloaded when you import them, so they need room too.
        </Li>
      </Ul>

      <Space h={2} />

      <HeaderH3>Photos or videos won&apos;t import</HeaderH3>
      <Space h={0.5} />
      <Ul>
        <Li>
          If they are in iCloud, connect to the internet and wait for them to
          download. In Files, items with a cloud icon need to be downloaded
          first.
        </Li>
        <Li>Make sure there is enough free space (see above).</Li>
        <Li>
          Try a few items at a time to find out if one file is the problem.
        </Li>
        <Li>
          If a file uses an unusual format, export it from its original app as a
          JPEG photo or a standard video and try again.
        </Li>
        <Li>Update to the latest version of iOS or iPadOS and of the app.</Li>
      </Ul>
      <Space h={1} />
      <Text>
        If it still doesn&apos;t work, <A href={SUPPORT_MAIL}>email me</A> and
        say what kind of file it is and where it came from.
      </Text>

      <Space h={2} />

      <HeaderH3>Privacy</HeaderH3>
      <Space h={0.5} />
      <Text>
        The app has no account, analytics, tracking, ads or uploads. Read the
        full <A href={`${BASE_PATH}/privacy`}>privacy policy</A>.
      </Text>

      <Space h={2} />
      <Text>
        Made by <A href="https://javier.xyz">Javier Bórquez</A>.
      </Text>
    </Container>
  );
}
