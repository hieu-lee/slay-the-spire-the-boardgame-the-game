import { assetPath } from "../../game/assets.ts";

export function Price({ value, sale = false }: { value: number | null; sale?: boolean }) {
  return (
    <span className={`room-price${sale ? " room-price--sale" : ""}`}>
      {value === null ? "Sold" : <>{sale ? <span className="room-price__sale-mark" aria-hidden="true">%</span> : null}
        <img src={assetPath("icons/gold.png")} alt="" />{value}
        <span className="visually-hidden"> Gold{sale ? ", on sale" : ""}</span></>}
    </span>
  );
}
