import {
  A,
  Container,
  HeaderH3,
  MainHeader,
  MoreExperiments,
  Space,
  Text,
} from 'jbx';

import StarTrailsApp from '../components/StarTrailsApp.jsx';

export default function Page() {
  return (
    <Container as="main">
      <MainHeader>star-trails</MainHeader>
      <Space h={1} />
      <Text>
        Stack timelapse photos or a video into one star trail image. Photo
        exports preserve the EXIF from the first frame.
      </Text>

      <StarTrailsApp />

      <Space h={1} />

      <HeaderH3>How does it work?</HeaderH3>
      <Space h={0.5} />
      <Text>
        Every frame uses a <strong>lighten</strong> blend, keeping the brightest
        pixel at each position. The stars move between frames, drawing trails
        while the landscape stays still.
      </Text>
      <Space h={1} />
      <Text>
        <strong>Curve</strong> fades each trail in across whatever range you
        select, so the trails stretch as you widen it — higher decay makes a
        brighter, sharper head. <strong>Linear</strong> steps the fade down by a
        fixed amount per frame instead, so a trail length set in frames holds
        however much is selected. <strong>Min opacity</strong> keeps older
        frames visible.
      </Text>

      <Space h={2} />

      <HeaderH3>Shooting for it</HeaderH3>
      <Space h={0.5} />
      <Text>
        Use 20 to 40 second exposures with the shortest gap possible. Shoot on a
        tripod and lock focus and exposure. More frames give you more room to
        adjust the range later.
      </Text>

      <Space h={2} />

      <HeaderH3>Your photos stay on your computer</HeaderH3>
      <Space h={0.5} />
      <Text>
        Everything runs in your browser. Nothing is uploaded, and your photos
        and videos never leave your computer. There is also a{' '}
        <A href="https://github.com/javierbyte/startrails">
          command line version
        </A>{' '}
        for processing a folder from the terminal.
      </Text>

      <Space h={2} />

      <MoreExperiments exclude="startrails" />

      <Space h={2} />
      <Text>
        Made by <A href="https://javier.xyz">Javier Bórquez</A>.
      </Text>
    </Container>
  );
}
