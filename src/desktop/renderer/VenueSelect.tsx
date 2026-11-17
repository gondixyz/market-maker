import { type Venue, VENUE_NAMES, VENUES } from '../../engine/market';
import { Select } from './Select';
import { GondiMark, OpenSeaMark } from './VenueIcons';

/** The venue's mark beside its name. */
export const VenueLabel = ({ venue, size = 18 }: { venue: Venue; size?: number }) => (
  <span className="venueLabel">
    {venue === 'opensea' ? <OpenSeaMark size={size} /> : <GondiMark size={size} />}
    {VENUE_NAMES[venue]}
  </span>
);

/** Where an order is posted, as a `Select` whose options show each of `venues`' marks. */
export const VenueSelect = ({
  value,
  venues = VENUES,
  disabled,
  onChange,
}: {
  value: Venue;
  venues?: readonly Venue[];
  disabled: boolean;
  onChange: (venue: Venue) => void;
}) => (
  <Select
    value={value}
    options={venues}
    labelOf={(venue) => <VenueLabel venue={venue} />}
    disabled={disabled}
    onChange={onChange}
  />
);
