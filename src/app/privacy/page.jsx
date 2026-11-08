import { A, Container, HeaderH3, Li, MainHeader, Space, Text, Ul } from 'jbx';

import { BASE_PATH } from '../../lib/constants.js';

const TITLE = 'Privacy Policy | Star Trails for iPhone and iPad';
const DESCRIPTION =
  'The Star Trails app for iPhone and iPad does not collect any data. Your photos and videos are processed on your device and never leave it.';
const CANONICAL = 'https://javier.xyz/startrails/privacy';
const THUMBNAIL = 'https://javier.xyz/startrails/javier-xyz-startrails.jpg';
const UPDATED = 'November 8, 2026';

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

export default function PrivacyPage() {
  return (
    <Container as="main">
      <MainHeader>star-trails privacy</MainHeader>
      <Space h={1} />
      <Text>
        This policy covers the Star Trails app for iPhone and iPad. The website
        has <A href="#website">its own section</A> below. Last updated {UPDATED}
        .
      </Text>

      <Space h={2} />

      <HeaderH3>The short version</HeaderH3>
      <Space h={0.5} />
      <Text>
        The app does not collect any data. There is no account or login, and no
        analytics, tracking, ads or uploads. Your photos and videos are
        processed on your device. They are never sent to me or anyone else.
      </Text>

      <Space h={2} />

      <HeaderH3>Your photos and videos</HeaderH3>
      <Space h={0.5} />
      <Text>
        You choose what to open with the system Photos and Files pickers. The
        app only sees the items you pick, not the rest of your library or your
        files.
      </Text>
      <Space h={1} />
      <Text>
        When you save an export to Photos, iOS asks for permission to add
        photos. This is add-only permission. It lets the app save new items, but
        not see or change anything already in your library.
      </Text>

      <Space h={2} />

      <HeaderH3>What stays on your device</HeaderH3>
      <Space h={0.5} />
      <Text>
        While you work, the app keeps copies of your imported items, the frames
        it samples from videos, and your exports in its private storage on your
        device. These temporary files are deleted afterwards. Deleting the app
        also removes anything left in its storage.
      </Text>
      <Space h={1} />
      <Text>
        Exports you save to Photos or Files are yours. They stay where you put
        them until you delete them.
      </Text>

      <Space h={2} />

      <HeaderH3>Location and other metadata in exports</HeaderH3>
      <Space h={0.5} />
      <Text>
        JPEG and Live Photo exports can keep the metadata of the first selected
        frame. This can include the camera, the date and time, and the{' '}
        <strong>GPS location</strong> where it was taken. If you share an
        export, that information goes with it.
      </Text>
      <Space h={1} />
      <Text>
        To share without the location, tap <strong>Options</strong> at the top
        of the share sheet in Photos and turn off <strong>Location</strong>. You
        can also remove the location from a saved photo in Photos. Swipe up on
        the photo, tap <strong>Adjust</strong> next to the location, and choose{' '}
        <strong>No Location</strong>.
      </Text>

      <Space h={2} />

      <HeaderH3>Sharing with others</HeaderH3>
      <Space h={0.5} />
      <Text>
        The app collects nothing, so there is nothing to share with anyone. It
        has no analytics or advertising services and does not sell or share
        data. The App Store label for the app is{' '}
        <strong>Data Not Collected</strong>.
      </Text>
      <Space h={1} />
      <Text>
        Apple handles downloads and updates under{' '}
        <A href="https://www.apple.com/legal/privacy/">
          Apple&apos;s privacy policy
        </A>
        . If you turned on <strong>Share With App Developers</strong> in your
        device&apos;s Analytics settings, Apple may send me crash reports and
        anonymous usage totals. That data comes from Apple, not from the app,
        and you can turn it off at any time in Settings › Privacy &amp; Security
        › Analytics &amp; Improvements.
      </Text>

      <Space h={2} />

      <HeaderH3>Your choices</HeaderH3>
      <Space h={0.5} />
      <Ul>
        <Li>
          To remove the app&apos;s permission to add photos, go to Settings ›
          Apps › Star Trails › Photos and choose <strong>None</strong>.
        </Li>
        <Li>
          To delete everything the app stores on your device, delete the app.
        </Li>
        <Li>
          I hold no data about you from the app, so there is nothing for me to
          delete or hand over.
        </Li>
      </Ul>

      <Space h={2} />

      <HeaderH3>If you email me</HeaderH3>
      <Space h={0.5} />
      <Text>
        If you write to <A href="mailto:hi@javier.xyz">hi@javier.xyz</A>, I
        receive your email address and anything you include in the message, like
        screenshots. I use it only to reply to you. I don&apos;t share it, and
        I&apos;ll delete it if you ask.
      </Text>

      <Space h={2} />

      <HeaderH3 id="website">This website</HeaderH3>
      <Space h={0.5} />
      <Text>
        This section is about the website, not the app. The pages under
        javier.xyz/startrails, including this one and the web version of Star
        Trails, use Google Analytics to count visits. Google Analytics uses
        cookies and receives information such as the pages you view, your
        browser and device, and your approximate location based on your IP
        address. Google handles this data under{' '}
        <A href="https://policies.google.com/technologies/partner-sites">
          its own policies
        </A>
        . You can block it with your browser&apos;s cookie or content blocking
        settings, or with the{' '}
        <A href="https://tools.google.com/dlpage/gaoptout">
          Google Analytics opt-out add-on
        </A>
        .
      </Text>
      <Space h={1} />
      <Text>
        The site is hosted on GitHub Pages and served through Vercel. Like any
        web host, they process the network details needed to deliver each page,
        such as your IP address. The web tool processes your photos and videos
        in your browser and does not upload them.
      </Text>

      <Space h={2} />

      <HeaderH3>Changes and contact</HeaderH3>
      <Space h={0.5} />
      <Text>
        If this policy changes, I&apos;ll update it here and change the date at
        the top. Questions are welcome at{' '}
        <A href="mailto:hi@javier.xyz">hi@javier.xyz</A>. For help with the app,
        see <A href={`${BASE_PATH}/support`}>support</A>.
      </Text>

      <Space h={2} />
      <Text>
        Made by <A href="https://javier.xyz">Javier Bórquez</A>.
      </Text>
    </Container>
  );
}
