import {z} from 'zod';
import {database} from './database.js';
import {istDate,dayRange} from './utils.js';

export function analyticsPeriod(query) {
  const {days}=z.object({days:z.coerce.number().int().refine(n=>[7,30,90].includes(n),'Select 7, 30 or 90 days').default(7)}).strict().parse(query);
  const to=istDate(),from=new Date(Date.parse(to+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
  return {days,from,to,range:{$gte:dayRange(from).$gte,$lt:dayRange(to).$lt}};
}

export async function dailyAnalytics(period,shopId=null) {
  const {days,from,to,range}=period;
  const params=[range.$gte,range.$lt];
  if(shopId)params.push(shopId);
  const {rows}=await database().query(`SELECT to_char("paidAt" AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS date,
    count(*)::integer AS orders,COALESCE(sum(total),0)::bigint AS revenue
    FROM fresh_me.orders WHERE "paidAt">=$1 AND "paidAt"<$2 ${shopId?'AND "shopId"=$3':''}
    GROUP BY 1 ORDER BY 1`,params);
  const values=new Map(rows.map(row=>[row.date,{orders:row.orders,revenue:Number(row.revenue)}]));
  const daily=Array.from({length:days},(_,i)=>{
    const date=new Date(Date.parse(from+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
    return {date,orders:0,revenue:0,...values.get(date)};
  });
  const totals=daily.reduce((sum,row)=>({orders:sum.orders+row.orders,revenue:sum.revenue+row.revenue}),{orders:0,revenue:0});
  return {days,from,to,daily,totals};
}
