/** Ether's mark, as gondi.xyz draws it. */
export const EthIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="-4 -4 40 40" role="img" aria-label="ETH">
    <g fill="none" fillRule="evenodd">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#FFF" fillRule="nonzero">
        <path fillOpacity=".602" d="M16.498 4v8.87l7.497 3.35z" />
        <path d="M16.498 4L9 16.22l7.498-3.35z" />
        <path fillOpacity=".602" d="M16.498 21.968v6.027L24 17.616z" />
        <path d="M16.498 27.995v-6.028L9 17.616z" />
        <path fillOpacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
        <path fillOpacity=".602" d="M9 16.22l7.498 4.353v-7.701z" />
      </g>
    </g>
  </svg>
);

/** Wrapped ether's mark, as gondi.xyz draws it. */
export const WethIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="WETH">
    <path
      d="M11.9966 2L11.8604 2.45574V15.6802L11.9966 15.814L18.2336 12.1855L11.9966 2Z"
      fill="#DA3979"
    />
    <path d="M11.9968 2L5.75977 12.1855L11.9968 15.8141V9.39533V2Z" fill="#E781A9" />
    <path
      d="M11.9972 16.9764L11.9204 17.0685V21.7793L11.9972 22L18.2379 13.3496L11.9972 16.9764Z"
      fill="#DA3979"
    />
    <path d="M11.9968 21.9999V16.9763L5.75977 13.3495L11.9968 21.9999Z" fill="#E781A9" />
    <path d="M11.9976 15.814L18.2345 12.1855L11.9976 9.39532V15.814Z" fill="#671334" />
    <path d="M5.75977 12.1855L11.9967 15.814V9.39532L5.75977 12.1855Z" fill="#DA3979" />
  </svg>
);
